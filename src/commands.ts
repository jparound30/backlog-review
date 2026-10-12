import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { BacklogClient } from "./backlog/client.ts";
import type { PullRequestRef } from "./backlog/url.ts";
import { findSecretPattern } from "./backlog/secrets.ts";
import { changedFiles, diffFiles } from "./git/diff.ts";
import { blobIdAt, readBlob, runGit } from "./git/git.ts";
import {
  allowedReplyStatuses,
  assessInterpretation,
  type PointInput,
  type StoredInterpretation,
  type StoredPoint,
  validateInterpretations,
} from "./interpret/interpretation.ts";
import { firstLine, formatReply, formatSummary, type ReplyLocation } from "./reply/format.ts";
import { loadState, saveJsonAtomic, snapshotPath, STATE_ROOT as STATE_DIR, statePath } from "./state/store.ts";
import {
  assertSafeBranchName,
  isUnsafePath,
  resolveRef,
  type Snapshot,
  type SnapshotComment,
  type SnapshotItem,
  sync,
  type SyncContext,
} from "./sync.ts";
import { isReplyStatus, label, parseItemKey, type ReplyStatus } from "./thread/marker.ts";

export type CommandContext = SyncContext & { client: BacklogClient; out: (line: string) => void };

const pad = (text: string, width: number) => {
  // 全角文字は 2 桁として数える
  const w = [...text].reduce((n, ch) => n + (/[\u0000-ÿ]/.test(ch) ? 1 : 2), 0);
  return text + " ".repeat(Math.max(0, width - w));
};

function shortLocation(comment: SnapshotComment): string {
  const loc = comment.location;
  if (!loc) return "場所の指定なし";
  if (loc.error) return `${loc.filePath}（位置不明: ${loc.error}）`;
  const side = loc.side === "old" ? "旧" : "";
  const outdated = loc.outdated
    ? loc.currentLine
      ? ` → 現在 L${loc.currentLine}${loc.currentLineChanged ? "（行は変更済み）" : ""}`
      : "（更新により位置不明）"
    : "";
  return `${loc.filePath} ${side}L${loc.line}${outdated}`;
}

function printWarnings(snapshot: Snapshot, ctx: CommandContext) {
  for (const w of snapshot.warnings) ctx.out(w.commentId ? `⚠️  #${w.commentId}: ${w.message}` : `⚠️  ${w.message}`);
  for (const item of snapshot.items) {
    if (item.editedAfterReply) ctx.out(`⚠️  ${item.label}: 返信の後に指摘が編集されています。内容を確認してください`);
  }
}

/** §3-2 手順 1: 取得と同期 */
export async function fetchCommand(pr: PullRequestRef, ctx: CommandContext, all = false): Promise<Snapshot> {
  const { snapshot } = await sync(pr, ctx);
  ctx.out(`PR: ${snapshot.pr.summary}（${snapshot.refs.base} ← ${snapshot.refs.branch}）`);
  ctx.out(`状態: ${Object.entries(snapshot.counts).map(([k, n]) => `${k} ${n}`).join(" / ") || "指摘なし"}`);
  printWarnings(snapshot, ctx);
  const shown = all ? snapshot.items : snapshot.items.filter((i) => i.status === "open");
  ctx.out(all ? "\n指摘の一覧:" : `\n未対応の指摘: ${shown.length} 件`);
  for (const item of shown) {
    const mark = item.status === "open" && item.needsInterpretation ? "（要解釈）" : "";
    ctx.out(
      `  ${pad(item.label, 14)} ${pad(item.status, 14)} ${pad(item.root.author.name, 16)} ${shortLocation(item.root)}${mark}`,
    );
    ctx.out(`      ${firstLine(item.followUps.at(-1)?.content ?? item.root.content, 70)}`);
    // 回答を受けて open に戻った指摘は、前回の Bot の返信を踏まえて解釈し直す（§5-1 の 5）
    const lastReply = item.history.findLast((h) => h.status !== undefined);
    if (item.status === "open" && lastReply) {
      ctx.out(`      前回の返信: ${lastReply.status} #${lastReply.id}（history で質問と回答を確かめること）`);
    }
  }
  ctx.out(`\nスナップショット: ${snapshotPath(ctx.stateRoot, pr)}`);
  return snapshot;
}

function treatment(interp: StoredInterpretation): string {
  const reasons = interp.rankReasons.join("、");
  switch (interp.replyStatus) {
    case "fixed":
      return interp.points.length > 1 ? `自動修正の候補（論点 ${interp.points.length} 件を 1 コミットで直す）` : "自動修正の候補";
    case "needs_info":
      if (interp.fixableWithApproval) {
        const docs = interp.points.flatMap((p) => p.scope.docs ?? []);
        return `利用者が選べば修正（仕様書も同じコミットで更新: ${docs.join(", ")}）。選ばなければ確認の質問を返す`;
      }
      if (interp.points.some((p) => p.kind === "fix" && p.rank === "high")) {
        return `修正せず確認の質問を返す（${reasons}）。直し方が決まっている論点は、回答の後にまとめて直す`;
      }
      return interp.points.some((p) => p.kind !== "needs_info") ? `修正せず確認の質問を返す（${reasons}）` : "確認の質問を返す";
    case "answered":
      return "回答のみ";
    case "wontfix":
      return "見送りの理由を返す（要判断）";
    case null:
      return "返信しない";
  }
}

const pointLabel = (p: StoredPoint) => `${p.kind}${p.rank ? `・${p.rank}` : ""}`;

function countLines(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/**
 * 論点の場所を、リポジトリの内容と照らし合わせる（§3-3「CLI が照合する事実」, R-5）。
 * 行番号がファイルの行数を超えていれば problems に、ファイルが見つからなければ notes に入れる
 */
async function checkPointFiles(
  points: PointInput[],
  refs: Snapshot["refs"],
  repoDir: string,
  key: string,
): Promise<{ problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const [i, p] of points.entries()) {
    if (!p.location.path) continue;
    const at = points.length > 1 ? `${label(key)} の論点 ${i + 1}` : label(key);
    // 削除行への指摘もあるので、PR のブランチになければ base のファイルを見る
    const blob =
      (await blobIdAt(repoDir, refs.branchCommit, p.location.path)) ?? (await blobIdAt(repoDir, refs.baseCommit, p.location.path));
    if (!blob) {
      notes.push(`${at}: ${p.location.path} は PR のブランチにも base にもありません`);
      continue;
    }
    const lines = countLines(await readBlob(repoDir, blob));
    if (p.location.line !== null && p.location.line > lines) {
      problems.push(`${at}: location.line（${p.location.line}）が ${p.location.path} の行数（${lines}）を超えています`);
    }
  }
  return { problems, notes };
}

/** 確認①で知らせる、判定と事実の食い違い（R-5）。ランクは変えない */
function interpretationNotes(item: SnapshotItem, interp: StoredInterpretation, changed: Set<string>): string[] {
  const notes: string[] = [];
  const loc = item.root.location;
  if (loc && !loc.error && !interp.points.some((p) => p.location.path === loc.filePath)) {
    notes.push(`行コメントの場所（${loc.filePath}）を指す論点がありません。論点の場所を確かめてください`);
  }
  interp.points.forEach((p, i) => {
    if (p.location.path && !changed.has(p.location.path)) {
      const at = interp.points.length > 1 ? `論点 ${i + 1} の ` : "";
      notes.push(`${at}${p.location.path} は PR の変更ファイルにありません（範囲外のファイルを触る案として、利用者に選んでもらう）`);
    }
  });
  return notes;
}

/** 確認①に出す、元のコメントなどの全文。長すぎる場合は切り詰める */
function quoteBlock(text: string, maxLines = 30): string[] {
  const lines = text.trimEnd().split("\n");
  const shown = lines.slice(0, maxLines).map((l) => `         | ${l}`);
  if (lines.length > maxLines) shown.push(`         | …（ほか ${lines.length - maxLines} 行）`);
  return shown;
}

/** §3-2 手順 2〜4: 解釈を検証してランクを決め、確認①の一覧を出す */
export async function interpretCommand(pr: PullRequestRef, file: string, ctx: CommandContext): Promise<void> {
  const { items: inputs, errors } = validateInterpretations(JSON.parse(await readFile(file, "utf8")));
  if (errors.length > 0) throw new Error(`解釈の JSON に問題があります:\n${errors.map((e) => `  ${e}`).join("\n")}`);

  const { snapshot, state, fetched } = await sync(pr, ctx);
  const problems: string[] = [];
  const fileNotes = new Map<string, string[]>();
  const now = new Date().toISOString();
  for (const input of inputs) {
    const item = snapshot.items.find((i) => i.key === input.key && i.status === "open");
    if (!item) {
      problems.push(`${label(input.key)} は未対応（open）の指摘ではありません`);
      continue;
    }
    const checked = await checkPointFiles(input.points, snapshot.refs, ctx.repoDir, input.key);
    problems.push(...checked.problems);
    fileNotes.set(input.key, checked.notes);
    state.interpretations[input.key] = {
      key: input.key,
      ...assessInterpretation(input.points),
      rootUpdated: item.root.updated,
      lastHumanCommentId: item.replyToId,
      interpretedAt: now,
    };
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  state.log.push({ at: now, action: "interpret", detail: inputs.map((i) => i.key).join(",") });
  await saveJsonAtomic(statePath(ctx.stateRoot, pr), state);

  // not_actionable の判定を反映するため作り直す。コメントは同じコマンドの中で取得したものを使い回す（R-17）
  const refreshed = (await sync(pr, ctx, fetched)).snapshot;
  const open = refreshed.items.filter((i) => i.status === "open");
  if (refreshed.conventionChanges.length > 0) {
    ctx.out("⚠️  この PR で規約のファイルが変更されています。修正の前に利用者に伝え、内容を確かめてもらうこと:");
    for (const path of refreshed.conventionChanges) ctx.out(`    ${path}`);
    ctx.out("");
  }
  ctx.out("解釈の結果（確認①）:");
  const changed = new Set(refreshed.changedFiles.map((f) => f.path));
  let n = 0;
  const listed: string[] = [];
  for (const item of open) {
    const interp = item.interpretation;
    if (!interp) continue;
    listed.push(item.key);
    const multiple = interp.points.length > 1;
    const head = multiple ? `論点 ${interp.points.length} 件` : pointLabel(interp.points[0]);
    ctx.out(`${String(++n).padStart(3)}. ${pad(item.label, 14)} ${pad(head, 14)} 返信: ${interp.replyStatus}  ランク: ${interp.rank ?? "-"}`);
    // 論点を書かずに落としていないかを利用者が見比べられるよう、元のコメントの全文を出す（R-5）
    ctx.out("       元のコメント:");
    for (const line of quoteBlock(item.root.content)) ctx.out(line);
    const latest = item.followUps.at(-1);
    if (latest) {
      ctx.out("       最新の追加の指示・回答:");
      for (const line of quoteBlock(latest.content, 15)) ctx.out(line);
    }
    interp.points.forEach((p, i) => {
      const indent = multiple ? "         " : "       ";
      if (multiple) ctx.out(`       論点 ${i + 1}（${pointLabel(p)}）: ${p.summary ?? ""}`);
      ctx.out(`${indent}場所: ${p.location.path ?? "不明"}${p.location.line ? ` L${p.location.line}` : ""}（${p.location.judgment}: ${p.location.reason}）`);
      ctx.out(`${indent}意図: ${p.intent.judgment}（${p.intent.reason}） / 影響範囲: ${p.scope.judgment}（${p.scope.reason}）`);
      if (p.scope.docs?.length) ctx.out(`${indent}更新する仕様書: ${p.scope.docs.join(", ")}`);
      ctx.out(`${indent}方針: ${p.plan}`);
    });
    ctx.out(`       扱い: ${treatment(interp)}`);
    for (const note of [...(fileNotes.get(item.key) ?? []), ...interpretationNotes(item, interp, changed)]) {
      ctx.out(`       ⚠️ ${note}`);
    }
  }
  // 返信しない指摘も必ず見せる（状態ファイルの改ざんなどで指摘が黙って隠れないように, §6-1）
  const silent = refreshed.items.filter((i) => i.status === "not_actionable");
  if (silent.length > 0) {
    ctx.out("\n返信しない指摘（not_actionable）:");
    for (const item of silent) {
      const plan = item.interpretation?.points.map((p) => p.plan).join(" / ");
      ctx.out(`    ${pad(item.label, 14)} ${firstLine(item.root.content, 50)}（${plan || "理由なし"}）`);
    }
  }
  const missing = open.filter((i) => !i.interpretation);
  if (missing.length > 0) ctx.out(`\n⚠️  解釈がまだない指摘: ${missing.map((i) => i.label).join(", ")}`);
  // 確認①の番号の並びを残す。select はこの並びで回答を読む（§8 M11）
  const latest = await loadState(statePath(ctx.stateRoot, pr), pr);
  latest.listed = { at: now, keys: listed };
  await saveJsonAtomic(statePath(ctx.stateRoot, pr), latest);
  ctx.out(`\n利用者の回答は select で番号を指摘に置き換える（例: select … --choice '1,3-5'）`);
}

function replyLocation(item: SnapshotItem): ReplyLocation | null {
  const placed = (item.interpretation?.points ?? []).filter((p) => p.location.path);
  const loc = item.root.location;
  // 行コメントの位置は Backlog の情報から確定する（§2-1）
  if (loc && !loc.error && loc.line !== null) {
    // ファイルが更新されていれば、差分から求めた現在の行番号を使う
    const line = loc.outdated ? loc.currentLine : loc.line;
    const others = placed.filter((p) => p.location.path !== loc.filePath || (p.location.line !== null && p.location.line !== line));
    return { path: loc.filePath, line, estimated: loc.outdated && line === null, more: others.length };
  }
  const [first, ...rest] = placed;
  if (first) {
    return { path: first.location.path!, line: first.location.line, estimated: first.location.judgment !== "explicit", more: rest.length };
  }
  // 解釈がなければ（別の環境・状態ファイルの消失など）、最後の自動返信に書いた場所を使う（§5-1 の 6）
  return item.lastReplyLocation;
}

/**
 * PR のブランチに push 済みの、PR のコミットか。
 * base 側の履歴にあるコミット（PR と関係のないもの）は通さない（S-11）
 */
export async function isPushed(repoDir: string, sha: string, branchCommit: string, baseCommit: string): Promise<boolean> {
  const onBranch = await runGit(repoDir, ["merge-base", "--is-ancestor", sha, branchCommit], [0, 1, 128]);
  if (onBranch.exitCode !== 0) return false;
  const onBase = await runGit(repoDir, ["merge-base", "--is-ancestor", sha, baseCommit], [0, 1, 128]);
  return onBase.exitCode !== 0;
}

const MAX_BODY_LENGTH = 4000;

/**
 * 返信の本文として読んでよいファイルか確かめる（§6-1）。
 * コメントに誘導されて手元の秘密のファイル（~/.ssh/… など）を投稿しないよう、
 * 一時ディレクトリか `.review-state/` の下にある `.md` だけを受け付ける
 */
async function allowedWorkFile(path: string, stateRoot: string, exts: string[], what: string): Promise<string> {
  const real = await realpath(path);
  const roots = await Promise.all(
    [tmpdir(), join(stateRoot, STATE_DIR)].map((root) => realpath(root).catch(() => null)),
  );
  const inside = roots.some((root) => root !== null && real.startsWith(root + sep));
  if (!inside || !exts.some((ext) => real.endsWith(ext))) {
    throw new Error(`${what}は、一時ディレクトリか .review-state/ の下の ${exts.join("・")} ファイルにしてください: ${path}`);
  }
  // 共有の一時ディレクトリでは、他の利用者が置いたファイルを読まない（S-11）
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${what}が通常のファイルではありません: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${what}のファイルが、自分の所有するファイルではありません: ${path}`);
  }
  return real;
}

const allowedBodyFile = (path: string, stateRoot: string) => allowedWorkFile(path, stateRoot, [".md"], "返信の本文");

/** コミットのメッセージの `Refs:` 行に、その指摘の番号があるか（手順書の書式, §3-2 手順 5） */
export function refsInclude(message: string, key: string): boolean {
  for (const line of message.matchAll(/^Refs:(.*)$/gim)) {
    for (const ref of line[1].matchAll(/RC-(\d+)/gi)) if (ref[1] === key) return true;
  }
  return false;
}

/** 指摘の修正で変わるはずのファイル（論点の場所・仕様書・行コメントのファイル） */
function expectedFiles(item: SnapshotItem, interp: StoredInterpretation): Set<string> {
  const expected = new Set<string>([
    ...interp.points.flatMap((p) => [p.location.path ?? "", ...(p.scope.docs ?? [])]),
    item.root.location?.filePath ?? "",
  ]);
  expected.delete("");
  return expected;
}

/**
 * ステージした変更を、指摘 1 件の修正としてコミットする（§3-2 手順 5, §8 M13）。
 * `Refs: RC-{id}` を付け、修正の対象の指摘か・PR のブランチの上か・ファイルが論点の場所と合うかを確かめる。
 * git には API キーを渡さない（runGit が外す）。対象リポジトリのフックはそのまま動く
 */
export async function commitCommand(
  pr: PullRequestRef,
  options: { key: string; messageFile: string },
  ctx: CommandContext,
): Promise<void> {
  const key = options.key.replace(/^RC-/, "");
  if (!parseItemKey(key)) throw new Error(`key が不正です: ${options.key}`);
  const message = (
    await readFile(await allowedWorkFile(options.messageFile, ctx.stateRoot, [".txt", ".md"], "コミットメッセージ"), "utf8")
  ).trim();
  if (message === "") throw new Error("コミットメッセージが空です");

  const { snapshot } = await sync(pr, ctx);
  const item = snapshot.items.find((i) => i.key === key);
  if (!item) throw new Error(`${label(key)} が見つかりません`);
  if (item.status !== "open") throw new Error(`${label(key)} はすでに ${item.status} です。修正しません`);
  const interp = item.interpretation;
  if (!interp) throw new Error(`${label(key)} はまだ解釈されていません。先に interpret を実行してください`);
  // 直し方の決まらない論点がある指摘は、どの論点も直さない（§3-3）
  if (!allowedReplyStatuses(interp).includes("fixed")) {
    throw new Error(`${label(key)} は修正の対象ではありません（返信の状態: ${interp.replyStatus ?? "返信しない"}。理由: ${interp.rankReasons.join("、") || "なし"}）`);
  }
  const onBranch = await runGit(ctx.repoDir, ["merge-base", "--is-ancestor", snapshot.refs.branchCommit, "HEAD"], [0, 1]);
  if (onBranch.exitCode !== 0) {
    throw new Error(`HEAD が ${snapshot.refs.branch} の上にありません。PR のブランチで作業しているか確かめてください`);
  }
  const staged = (await runGit(ctx.repoDir, ["diff", "--cached", "--name-only", "--no-renames", "-z"])).stdout.split("\0").filter(Boolean);
  if (staged.length === 0) throw new Error("ステージした変更がありません。git add -- '<ファイル>' で修正したファイルをステージしてください");
  const others = [...message.matchAll(/^Refs:(.*)$/gim)].flatMap((line) => [...line[1].matchAll(/RC-(\d+)/gi)].map((m) => m[1]));
  if (others.some((k) => k !== key)) {
    throw new Error(`メッセージに別の指摘の Refs: があります（${[...new Set(others)].map(label).join(", ")}）。1 つのコミットは 1 件の指摘だけにしてください`);
  }
  const full = refsInclude(message, key) ? message : `${message}\n\nRefs: ${label(key)}`;
  const leak = ctx.client.containsApiKey(full) ? "API キー" : findSecretPattern(full);
  if (leak) throw new Error(`コミットメッセージに ${leak} らしき文字列があるため、コミットしません`);

  const expected = expectedFiles(item, interp);
  const dir = await mkdtemp(join(tmpdir(), "bfr-commit-"));
  try {
    const file = join(dir, "message.txt");
    await writeFile(file, `${full}\n`, { mode: 0o600 });
    await runGit(ctx.repoDir, ["commit", "-q", "-F", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const sha = (await runGit(ctx.repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  ctx.out(`${label(key)} の修正をコミットしました: ${sha.slice(0, 7)}（ファイル ${staged.length} 件: ${staged.join(", ")}）`);
  if (expected.size > 0 && !staged.some((f) => expected.has(f))) {
    ctx.out(`⚠️  ステージしたファイルは、指摘の場所や仕様書のファイル（${[...expected].join(", ")}）のどれとも合いません。この指摘の修正か確かめてください`);
  }
  ctx.out(`返信の commits（--commit）には ${sha.slice(0, 7)} を使う`);
}

/**
 * fixed に付けるコミットが、この指摘を直したものかを確かめる（§3-1, R-4）。
 * メッセージに `Refs: RC-{key}` がなければ拒否する（別の指摘のコミットや、PR の作成者のコミットの取り違えを防ぐ）。
 * 論点の場所・仕様書・行コメントのファイルをどれも変えていなければ、警告を返す
 */
async function checkFixCommits(
  repoDir: string,
  key: string,
  item: SnapshotItem,
  interp: StoredInterpretation,
  commits: string[],
): Promise<string[]> {
  const expected = expectedFiles(item, interp);
  const warnings: string[] = [];
  for (const sha of commits) {
    const found = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], [0, 1]);
    if (found.exitCode !== 0) throw new Error(`コミット ${sha} が対象リポジトリにありません`);
    const message = (await runGit(repoDir, ["log", "-1", "--format=%B", sha])).stdout;
    if (!refsInclude(message, key)) {
      throw new Error(
        `コミット ${sha} のメッセージに Refs: ${label(key)} がありません。この指摘を直したコミットか確かめてください（push 前ならメッセージを直せます）`,
      );
    }
    const files = (await runGit(repoDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", sha])).stdout
      .split("\0")
      .filter(Boolean);
    if (expected.size > 0 && !files.some((f) => expected.has(f))) {
      warnings.push(
        `コミット ${sha} は、指摘の場所や仕様書のファイル（${[...expected].join(", ")}）を変更していません。この指摘を直したコミットか確かめてください`,
      );
    }
  }
  return warnings;
}

export type ReplyOptions = { key: string; status: string; bodyFile: string; commits: string[]; post: boolean };

/** 1 件の返信の入力（`reply` の引数、または `reply --batch` の JSON の 1 要素） */
export type ReplyEntry = { key: string; status: string; bodyFile: string; commits: string[] };

/** 検査を通った返信。投稿する本文と、状態ファイルに残すコミット */
type PreparedReply = { key: string; status: string; text: string; fullCommits: string[]; warnings: string[] };

/** 返信の本文を読み、形を確かめる（同期の前にできる検査） */
async function readReplyBody(entry: ReplyEntry, stateRoot: string): Promise<string> {
  const key = entry.key.replace(/^RC-/, "");
  if (!parseItemKey(key)) throw new Error(`key が不正です: ${entry.key}`);
  if (!isReplyStatus(entry.status)) throw new Error(`status は fixed / answered / needs_info / wontfix のいずれかです`);
  const body = (await readFile(await allowedBodyFile(entry.bodyFile, stateRoot), "utf8")).trim();
  if (body === "") throw new Error("返信の本文が空です");
  // 返信は短い文章のはず。別のファイルを取り違えて投稿するのを防ぐ
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`返信の本文が長すぎます（${body.length} 文字。上限 ${MAX_BODY_LENGTH} 文字）`);
  }
  return body;
}

/** 同期した結果に対して返信を検査し、投稿する本文を作る（§3-1 の reply が拒否するもの） */
async function prepareReply(
  entry: ReplyEntry,
  body: string,
  snapshot: Snapshot,
  post: boolean,
  ctx: CommandContext,
): Promise<PreparedReply> {
  const key = entry.key.replace(/^RC-/, "");
  const status = entry.status as ReplyStatus;
  const item = snapshot.items.find((i) => i.key === key);
  if (!item) throw new Error(`${label(key)} が見つかりません`);
  // 同じ指摘への二重返信を防ぐ（再実行しても安全にする）
  if (item.status !== "open") throw new Error(`${label(key)} はすでに ${item.status} です。返信しません`);

  const interp = item.interpretation;
  if (!interp) throw new Error(`${label(key)} はまだ解釈されていません。先に interpret を実行してください`);
  // 返信の状態は、論点の組み合わせから CLI が決めたもの（§3-3）。自動修正は fix の論点がすべて high のときだけ。
  // 例外は、仕様書の更新だけが理由の mid（利用者が確認①で選んだもの, §7-4）
  const allowed = allowedReplyStatuses(interp);
  if (allowed.length === 0) throw new Error(`${label(key)} は返信しない指摘（not_actionable）です`);
  if (!allowed.includes(status)) {
    throw new Error(
      `${label(key)} の返信の状態は ${allowed.join(" か ")} です（論点の組み合わせから決まります。理由: ${interp.rankReasons.join("、") || "なし"}）`,
    );
  }
  const commits = entry.commits;
  for (const sha of commits) {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`コミットの形式ではありません: ${sha}`);
  }
  if (status === "fixed" && commits.length === 0) throw new Error("fixed にはコミットが必要です（--commit）");
  // 直し方の決まらない論点があるときは、どの論点も直さない（§3-3）
  if (status !== "fixed" && commits.length > 0) throw new Error("コミットを付けられるのは fixed の返信だけです");
  // 付けるコミットが、この指摘を直したものかを確かめる（§3-1, R-4）
  const warnings = await checkFixCommits(ctx.repoDir, key, item, interp, commits);
  const unpushed: string[] = [];
  for (const sha of commits) {
    if (!(await isPushed(ctx.repoDir, sha, snapshot.refs.branchCommit, snapshot.refs.baseCommit))) unpushed.push(sha);
  }
  // 下書き（確認②）は push 前に作るので警告にとどめ、投稿のときだけ拒否する
  if (unpushed.length > 0 && post) {
    throw new Error(
      `コミット ${unpushed.join(", ")} は ${snapshot.refs.branch} に push された PR のコミットではありません。push と git fetch の後に実行してください`,
    );
  }
  if (unpushed.length > 0) {
    warnings.push(`コミット ${unpushed.join(", ")} はまだ ${snapshot.refs.branch} にありません。投稿の前に push と git fetch が必要です`);
  }
  const fullCommits = await Promise.all(
    commits.map(async (sha) => (await runGit(ctx.repoDir, ["rev-parse", `${sha}^{commit}`])).stdout.trim()),
  );

  const target = [item.root, ...item.followUps].find((c) => c.id === item.replyToId) ?? item.root;
  const text = formatReply({
    key,
    replyTo: item.replyToId,
    reviewerName: target.author.name,
    quoteSource: target.content,
    status,
    location: replyLocation(item),
    body,
    commits: fullCommits,
    rankReasons:
      status === "needs_info" && interp.points.some((p) => p.kind === "fix" || p.kind === "wontfix")
        ? interp.rankReasons
        : undefined,
  });
  return { key, status, text, fullCommits, warnings };
}

/** 検査を通った返信を投稿し、すぐ状態ファイルに記録する（§5-1 の 4） */
async function postPrepared(pr: PullRequestRef, prepared: PreparedReply, ctx: CommandContext): Promise<number> {
  const posted = await ctx.client.postComment(pr, prepared.text);
  const latest = await loadState(statePath(ctx.stateRoot, pr), pr);
  if (prepared.fullCommits.length > 0) {
    latest.commits[prepared.key] = [...(latest.commits[prepared.key] ?? []), ...prepared.fullCommits];
  }
  latest.log.push({ at: new Date().toISOString(), action: `reply:${prepared.status}`, key: prepared.key, commentId: posted.id });
  await saveJsonAtomic(statePath(ctx.stateRoot, pr), latest);
  return posted.id;
}

/** §3-2 手順 7: 指摘に返信する */
export async function replyCommand(pr: PullRequestRef, options: ReplyOptions, ctx: CommandContext): Promise<void> {
  const body = await readReplyBody(options, ctx.stateRoot);
  const { snapshot } = await sync(pr, ctx);
  const prepared = await prepareReply(options, body, snapshot, options.post, ctx);
  for (const warning of prepared.warnings) ctx.out(`⚠️  ${warning}`);
  if (!options.post) {
    ctx.out("--- 投稿する内容（--yes を付けると投稿します）---");
    ctx.out(prepared.text);
    return;
  }
  const id = await postPrepared(pr, prepared, ctx);
  ctx.out(`${label(prepared.key)} に返信しました: #${id}`);
}

/** `reply --batch` の JSON を読む（§8 M11） */
export function parseReplyBatch(data: unknown): ReplyEntry[] {
  if (!Array.isArray(data) || data.length === 0) throw new Error("返信の JSON は、1 件以上の配列にしてください");
  const seen = new Set<string>();
  return data.map((raw, i) => {
    const r = raw as Record<string, unknown> | null;
    const at = `[${i}]`;
    if (!r || typeof r !== "object") throw new Error(`${at} オブジェクトではありません`);
    if (typeof r.key !== "string" || typeof r.status !== "string" || typeof r.bodyFile !== "string") {
      throw new Error(`${at} key・status・bodyFile（文字列）が必要です`);
    }
    const commits = r.commits ?? [];
    if (!Array.isArray(commits) || !commits.every((c) => typeof c === "string")) {
      throw new Error(`${at} commits は文字列の配列にしてください`);
    }
    // 同じ指摘への二重返信を防ぐ（同期は最初の 1 回だけなので、ここで止める）
    const key = r.key.replace(/^RC-/, "");
    if (seen.has(key)) throw new Error(`${at} ${label(key)} が 2 回含まれています`);
    seen.add(key);
    return { key: r.key, status: r.status, bodyFile: r.bodyFile, commits: commits as string[] };
  });
}

/**
 * 複数の返信をまとめて扱う（§8 M11, 改善案 A-3）。同期は最初の 1 回だけ。
 * 1 件が検査で拒否されても残りを続け、最後に失敗したものをまとめて示してエラーにする
 */
export async function replyBatchCommand(pr: PullRequestRef, file: string, post: boolean, ctx: CommandContext): Promise<void> {
  const entries = parseReplyBatch(JSON.parse(await readFile(file, "utf8")));
  const failures: string[] = [];
  const bodies = await Promise.all(
    entries.map((entry) =>
      readReplyBody(entry, ctx.stateRoot).catch((error: unknown) => {
        failures.push(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
    ),
  );
  const { snapshot } = await sync(pr, ctx);
  let done = 0;
  for (const [i, entry] of entries.entries()) {
    const body = bodies[i];
    if (body === null) continue;
    try {
      const prepared = await prepareReply(entry, body, snapshot, post, ctx);
      ctx.out(`--- ${label(prepared.key)}（${prepared.status}）${post ? "" : "の投稿する内容（--yes を付けると投稿します）"}---`);
      for (const warning of prepared.warnings) ctx.out(`⚠️  ${warning}`);
      if (post) {
        const id = await postPrepared(pr, prepared, ctx);
        ctx.out(`${label(prepared.key)} に返信しました: #${id}`);
      } else {
        ctx.out(prepared.text);
      }
      done++;
    } catch (error) {
      failures.push(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ctx.out(`\n${post ? "返信しました" : "下書きを作りました"}: ${done} 件 / ${entries.length} 件`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} 件は${post ? "返信" : "下書きを作成"}できませんでした:\n${failures.map((f) => `  ✖ ${f}`).join("\n")}`);
  }
}

/** 確認①の回答（`1,3-5` / `all` / `none`）を番号の集合にする */
export function parseChoice(choice: string, count: number): Set<number> {
  const text = choice.normalize("NFKC").trim().toLowerCase();
  const all = Array.from({ length: count }, (_, i) => i + 1);
  if (text === "all") return new Set(all);
  if (text === "none") return new Set();
  const chosen = new Set<number>();
  const tokens = text.split(/[\s,、]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("回答が空です（例: 1,3-5 / all / none）");
  for (const token of tokens) {
    const m = /^(\d+)(?:[-‐–−〜~](\d+))?$/.exec(token);
    if (!m) throw new Error(`回答を読めません: ${JSON.stringify(token)}（例: 1,3-5 / all / none）`);
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (from > to) throw new Error(`範囲が逆です: ${token}`);
    for (let n = from; n <= to; n++) {
      if (n < 1 || n > count) throw new Error(`番号 ${n} は一覧にありません（1〜${count}）`);
      chosen.add(n);
    }
  }
  return chosen;
}

/**
 * 確認①の回答を、指摘の番号と扱いに置き換える（§3-2 手順 4, §8 M11）。
 * 番号は interpret が一覧を出したときの並び（状態ファイルに残したもの）で数えるので、後から新しいコメントが来てもずれない
 */
export async function selectCommand(pr: PullRequestRef, choice: string, ctx: CommandContext): Promise<void> {
  const { snapshot, state } = await sync(pr, ctx);
  const listed = Array.isArray(state.listed?.keys) ? state.listed.keys.filter((k): k is string => typeof k === "string") : [];
  if (listed.length === 0) throw new Error("確認①の一覧がありません。先に interpret を実行してください");
  const items = listed.map((key) => snapshot.items.find((i) => i.key === key));
  const changed = listed.filter((key, i) => !items[i] || items[i]!.status !== "open" || !items[i]!.interpretation);
  if (changed.length > 0) {
    throw new Error(
      `一覧を出した後に、${changed.map(label).join(", ")} の状態か解釈が変わりました。interpret をやり直して、一覧を見せ直してください`,
    );
  }
  const chosen = parseChoice(choice, listed.length);

  const plan = (item: SnapshotItem, picked: boolean): [string, string] => {
    const interp = item.interpretation!;
    if (!picked) {
      return interp.fixableWithApproval ? ["needs_info", "選ばれなかったので、修正せずに確認の質問を返信する"] : ["-", "open のまま残す（返信しない）"];
    }
    if (interp.replyStatus === "fixed" || interp.fixableWithApproval) {
      const docs = interp.points.flatMap((p) => p.scope.docs ?? []);
      const parts = interp.points.length > 1 ? `論点 ${interp.points.length} 件を ` : "";
      return ["fixed", `修正して、${parts}1 コミットにし、fixed で返信する${docs.length > 0 ? `（仕様書も同じコミットで更新: ${docs.join(", ")}）` : ""}`];
    }
    switch (interp.replyStatus) {
      case "needs_info":
        return ["needs_info", "修正せずに、確認の質問を返信する"];
      case "answered":
        return ["answered", "回答を返信する"];
      case "wontfix":
        return ["wontfix", "見送りの理由を返信する（見送ってよいか利用者に確かめてから）"];
      default:
        return ["-", "返信しない"];
    }
  };

  ctx.out(`確認①の回答: ${choice}`);
  for (const [i, item] of items.entries()) {
    const [status, action] = plan(item!, chosen.has(i + 1));
    ctx.out(`${String(i + 1).padStart(3)}. ${pad(item!.label, 14)} ${chosen.has(i + 1) ? "選択" : "－  "}  ${pad(status, 11)} ${action}`);
  }
  const latest = await loadState(statePath(ctx.stateRoot, pr), pr);
  latest.log.push({ at: new Date().toISOString(), action: "select", detail: `${choice} → ${[...chosen].map((n) => listed[n - 1]).join(",")}` });
  await saveJsonAtomic(statePath(ctx.stateRoot, pr), latest);
}

/** §4-5: サマリーコメントを作成、または更新する */
export async function summaryCommand(pr: PullRequestRef, post: boolean, ctx: CommandContext): Promise<void> {
  const { snapshot } = await sync(pr, ctx);
  const text = formatSummary(
    snapshot.items.map((item) => ({
      key: item.key,
      reviewerName: item.root.author.name,
      summary: firstLine(item.root.content, 30),
      status: item.status,
      location: replyLocation(item),
      commits: item.commits,
      rootId: item.root.id,
      latestReplyId: item.botReplyIds.at(-1) ?? null,
    })),
  );
  if (!post) {
    ctx.out(`--- ${snapshot.summaryCommentId ? `#${snapshot.summaryCommentId} を更新` : "新規に投稿"}する内容（--yes を付けると反映します）---`);
    ctx.out(text);
    return;
  }
  const result = snapshot.summaryCommentId
    ? await ctx.client.updateComment(pr, snapshot.summaryCommentId, text)
    : await ctx.client.postComment(pr, text);
  const state = await loadState(statePath(ctx.stateRoot, pr), pr);
  state.summaryCommentId = result.id;
  state.log.push({ at: new Date().toISOString(), action: snapshot.summaryCommentId ? "summary:update" : "summary:create", commentId: result.id });
  await saveJsonAtomic(statePath(ctx.stateRoot, pr), state);
  ctx.out(`サマリーを${snapshot.summaryCommentId ? "更新" : "投稿"}しました: #${result.id}`);
}

/**
 * 空のツリーの ID。SHA-1 と SHA-256 のどちらのリポジトリでも求められるよう、git に計算させる
 * （Git for Windows も `/dev/null` を受け付ける）
 */
async function emptyTree(repoDir: string): Promise<string> {
  return (await runGit(repoDir, ["hash-object", "-t", "tree", "/dev/null"])).stdout.trim();
}

/**
 * push の前の検査（§6-1, 公開前チェック S-1）。
 * 出ていく差分の追加行とコミットメッセージに API キーや秘密情報があれば、エラーにして push させない。
 * PR の元の変更ファイルの範囲外に触れたファイルは、警告として一覧に出す。
 */
export async function checkPushCommand(pr: PullRequestRef, ctx: CommandContext): Promise<void> {
  const pullRequest = await ctx.client.getPullRequest(pr);
  assertSafeBranchName(pullRequest.base);
  assertSafeBranchName(pullRequest.branch);
  const base = `origin/${pullRequest.base}`;
  const branch = `origin/${pullRequest.branch}`;
  await resolveRef(ctx.repoDir, base);
  await resolveRef(ctx.repoDir, branch);
  const range = `${branch}..HEAD`;

  // 各行は「コミット 親 親…」。親がなければ、空のツリーとの差分を見る
  const lines = (await runGit(ctx.repoDir, ["rev-list", "--reverse", "--parents", range])).stdout.split("\n").filter(Boolean);
  const commits = lines.map((line) => line.split(" ")[0]);
  if (commits.length === 0) {
    ctx.out(`push するコミットはありません（${range}）`);
    return;
  }

  const problems: string[] = [];
  const leak = (text: string) => (ctx.client.containsApiKey(text) ? "API キー" : findSecretPattern(text));

  // コミットメッセージ
  for (const sha of commits) {
    const message = (await runGit(ctx.repoDir, ["log", "-1", "--format=%B", sha])).stdout;
    const found = leak(message);
    if (found) problems.push(`コミット ${sha.slice(0, 7)} のメッセージに ${found} らしき文字列があります`);
  }

  // コミットごとの追加行。push はコミットを 1 つずつ送るので、合計の差分だけを見ると、
  // 途中のコミットで足して後のコミットで消したものを見逃す（R-20）。
  // マージコミットは第 1 親との差分を見る（マージで持ち込まれた内容と、衝突の解決で書いた内容が入る）。
  // バイナリのファイルも文字として調べる
  const unsafe = new Set<string>();
  for (const line of lines) {
    const [sha, parent] = line.split(" ");
    const from = parent ?? (await emptyTree(ctx.repoDir));
    for (const file of await diffFiles(ctx.repoDir, [from, sha], { renames: false, text: true })) {
      if (isUnsafePath(file.path)) unsafe.add(file.path);
      const found = leak(file.added.join("\n"));
      if (found) problems.push(`コミット ${sha.slice(0, 7)} の ${file.path} の追加行に ${found} らしき文字列があります`);
    }
  }
  for (const path of unsafe) problems.push(`シェルで安全に扱えないパスがあります: ${JSON.stringify(path)}`);

  // push した後の PR のブランチと比べて、変更するファイル
  const files = await diffFiles(ctx.repoDir, [branch, "HEAD"], { renames: false });

  // PR の元の変更ファイルの範囲外
  const original = new Set((await changedFiles(ctx.repoDir, base, branch)).map((f) => f.path));
  const touched = files.map((f) => f.path);
  const outside = touched.filter((path) => !original.has(path));

  ctx.out(`push するコミット: ${commits.length} 件（${range}）`);
  for (const sha of commits) {
    const subject = (await runGit(ctx.repoDir, ["log", "-1", "--format=%s", sha])).stdout.trim();
    ctx.out(`  ${sha.slice(0, 7)} ${subject}`);
  }
  ctx.out(`変更するファイル: ${touched.length} 件`);
  for (const path of touched) ctx.out(`  ${path}${outside.includes(path) ? "  ⚠️ PR の元の変更ファイルの範囲外" : ""}`);

  if (problems.length > 0) {
    throw new Error(`push を中止してください:\n${problems.map((p) => `  ✖ ${p}`).join("\n")}`);
  }
  ctx.out(outside.length > 0 ? "⚠️ 範囲外のファイルがあります。確認②で利用者に伝えてください" : "✔ 問題は見つかりませんでした");
}

