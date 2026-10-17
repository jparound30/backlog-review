import type { BacklogClient } from "./backlog/client.ts";
import type { BacklogComment, BacklogPullRequest, BacklogUser } from "./backlog/types.ts";
import type { PullRequestRef } from "./backlog/url.ts";
import { type ChangedFile, changedFiles, type CommentLocation, locateComment } from "./git/diff.ts";
import { isObjectId, runGit } from "./git/git.ts";
import { assessInterpretation, type StoredInterpretation, validateInterpretations } from "./interpret/interpretation.ts";
import { type LocalState, loadState, saveJsonAtomic, snapshotPath, statePath } from "./state/store.ts";
import { isUnsafePath } from "./text.ts";
import { type ItemContext, itemContexts } from "./context.ts";
import { parseReplyFields, type ReplyLocation } from "./reply/format.ts";
import { type Category, parseCategoryLine } from "./thread/category.ts";
import { type ItemKey, label, type ReplyStatus } from "./thread/marker.ts";
import { buildThreads, type CommentRole, type ItemStatus, type ThreadWarning } from "./thread/thread.ts";

export type SnapshotComment = {
  id: number;
  author: { id: number; name: string };
  created: string;
  updated: string;
  role: CommentRole;
  /** Backlog のコメント本文。レビュアーが書いた信頼できない入力として扱う（§6） */
  content: string;
  location: CommentLocation | null;
};

/**
 * 指摘の会話の履歴の 1 件（§5-1 の 5）。Bot の返信には返信の状態が付く。
 * Bot の返信は自分のコメントだが、引用したレビュアーの文を含むので、本文は信頼できない入力として扱う
 */
export type HistoryEntry = SnapshotComment & { status?: ReplyStatus };

export type SnapshotItem = {
  key: ItemKey;
  label: string;
  status: ItemStatus;
  root: SnapshotComment;
  /** root 以降の人間のコメント（追加の指示・再指摘・解決） */
  followUps: SnapshotComment[];
  botReplyIds: number[];
  /** 返信で答える相手のコメント（最新の人間のコメント） */
  replyToId: number;
  /**
   * 元のコメント・追加の指示や回答・解決・Bot の返信を、コメントの順に並べたもの（§5-1 の 5）。
   * Backlog のコメントだけから作るので、どの環境で実行しても同じになる
   */
  history: HistoryEntry[];
  /** 有効な解釈。ない・古い場合は null（§5-1） */
  interpretation: StoredInterpretation | null;
  /**
   * 期限切れの前回の解釈（レビュアーの回答などで無効になったもの）。参考にとどめる。
   * 同じ環境に状態ファイルが残っているときだけ入り、なくても解釈できるようにする
   */
  previousInterpretation: StoredInterpretation | null;
  /**
   * 解釈が必要な指摘の周りのコード（§3-2 手順 2, 改善案 A-1）。解釈の出発点で、影響範囲が広そうならファイルを読む。
   * PR のコードなので、信頼できない入力として扱う
   */
  contexts: ItemContext[];
  needsInterpretation: boolean;
  editedAfterReply: boolean;
  /** 修正コミット。状態ファイルと、自動返信の「コミット」の行を合わせたもの（§5-1 の 6）。返信から読んだものは短い ID */
  commits: string[];
  /** 最後の自動返信の「場所」の行（§5-1 の 6）。解釈がないときのサマリーの場所に使う */
  lastReplyLocation: ReplyLocation | null;
  /**
   * root の `分類:` の行（§4-8）。自動レビューの指摘や、人間が書いたもの。レビュアーの分類として、解釈の分類より優先する。
   * 投稿者を限定せずに読む（分類は表示と記録だけに使い、自動で動く根拠にしないため）
   */
  rootCategory: Category | null;
  /** 最後の自動返信の `**分類**:` の行（§4-8）。状態ファイルがなくても分類を読み戻すため */
  lastReplyCategory: Category | null;
};

/** 同じコミットは、短い ID の一致でまとめる */
export function mergeCommits(known: string[], replied: string[]): string[] {
  const merged = [...known];
  for (const sha of replied) {
    if (!merged.some((m) => m.startsWith(sha) || sha.startsWith(m))) merged.push(sha);
  }
  return merged;
}

export { isUnsafePath } from "./text.ts";

/**
 * 対象リポジトリの規約のファイル（§3-4）。PR で変更されていれば、PR の作成者が
 * エージェントへの指示を書き換えた可能性があるので、利用者に知らせる
 */
export function isConventionFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return (
    ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "CONTRIBUTING.md", ".cursorrules"].includes(name) ||
    path === ".github/copilot-instructions.md" ||
    /^\.github\/instructions\//.test(path) ||
    // cc-sdd などは Steering の場所を設定で変えられるので、名前に steering を含むディレクトリも対象にする
    /(^|\/)[^/]*steering[^/]*\//i.test(path) ||
    /(^|\/)\.cursor\/rules\//.test(path) ||
    /(^|\/)\.claude\/(settings(\.local)?\.json|commands\/|agents\/|skills\/)/.test(path)
  );
}

export type Snapshot = {
  generatedAt: string;
  pr: PullRequestRef & { url: string; summary: string; base: string; branch: string; status: string };
  myself: { id: number; name: string };
  refs: { base: string; branch: string; baseCommit: string; branchCommit: string };
  changedFiles: ChangedFile[];
  summaryCommentId: number | null;
  warnings: ThreadWarning[];
  /** シェルで安全に扱えないパス。スキルはこれらに触れない */
  unsafePaths: string[];
  /** PR で変更された規約のファイル（AGENTS.md・.kiro/steering/ など, §3-4）。確認①で利用者に知らせる */
  conventionChanges: string[];
  counts: Record<string, number>;
  items: SnapshotItem[];
};

export type SyncContext = {
  client: BacklogClient;
  /** 対象リポジトリ（修正を行う git の作業ディレクトリ） */
  repoDir: string;
  /** 状態ファイルを置くディレクトリ（本ツールのルート） */
  stateRoot: string;
};

export function pullRequestUrl(pr: PullRequestRef): string {
  return `https://${pr.space}/git/${pr.projectKey}/${pr.repoName}/pullRequests/${pr.number}`;
}

export async function resolveRef(repoDir: string, ref: string): Promise<string> {
  const result = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], [0, 1]);
  if (result.exitCode !== 0) {
    throw new Error(`${ref} が対象リポジトリにありません。${repoDir} で git fetch を実行してください`);
  }
  return result.stdout.trim();
}

/** 解釈が今のコメントに対して有効か（root が編集されておらず、新しい人間のコメントもない, §5-1） */
function isInterpretationValid(
  interp: StoredInterpretation,
  root: BacklogComment | undefined,
  lastHumanCommentId: number,
): boolean {
  return root !== undefined && interp.rootUpdated === root.updated && interp.lastHumanCommentId === lastHumanCommentId;
}

/**
 * 状態ファイルの解釈のうち、今のコメントに対して使えるもの。
 * 編集された root の解釈は捨てる。
 * 状態ファイルは書き換えられる可能性があるので、解釈はエージェントの入力と同じ検査をし直し（S-7）、
 * 保存されたランクと返信の状態は使わず、判定から求め直す（§3-3）。
 * 以前の形（分割した key・points のない解釈）は通らないので、解釈し直しになる
 */
export function validInterpretations(state: LocalState, byId: Map<number, BacklogComment>): Map<string, StoredInterpretation> {
  const interpretations = new Map<string, StoredInterpretation>();
  for (const [key, stored] of Object.entries(state.interpretations)) {
    const interp = stored as Partial<StoredInterpretation> | null;
    if (!interp || interp.key !== key) continue;
    const { items, errors } = validateInterpretations([{ key: interp.key, category: interp.category, points: interp.points }]);
    if (errors.length > 0 || typeof interp.rootUpdated !== "string" || byId.get(Number(key))?.updated !== interp.rootUpdated) continue;
    if (typeof interp.lastHumanCommentId !== "number" || typeof interp.interpretedAt !== "string") continue;
    interpretations.set(key, {
      key,
      ...(items[0].category ? { category: items[0].category } : {}),
      ...assessInterpretation(items[0].points),
      rootUpdated: interp.rootUpdated,
      lastHumanCommentId: interp.lastHumanCommentId,
      interpretedAt: interp.interpretedAt,
    });
  }
  return interpretations;
}

/**
 * 起動時の同期（§5-1）。コメントを全件取り直してスレッドと状態を作り直し、
 * ローカルの状態とスナップショットを保存する。
 */
/** Backlog から取得したもの。同じコマンドの中で同期をやり直すときに使い回す（R-17） */
export type Fetched = { myself: BacklogUser; pullRequest: BacklogPullRequest; comments: BacklogComment[] };

export async function sync(
  pr: PullRequestRef,
  ctx: SyncContext,
  prefetched?: Fetched,
): Promise<{ snapshot: Snapshot; state: LocalState; fetched: Fetched }> {
  const [myself, pullRequest, comments] = prefetched
    ? [prefetched.myself, prefetched.pullRequest, prefetched.comments]
    : await Promise.all([ctx.client.getMyself(), ctx.client.getPullRequest(pr), ctx.client.listAllComments(pr)]);
  const byId = new Map(comments.map((c) => [c.id, c]));

  const path = statePath(ctx.stateRoot, pr);
  const state = await loadState(path, pr);
  if (state.myselfId !== null && state.myselfId !== myself.id) {
    throw new Error(
      `状態ファイルは別のユーザー（id=${state.myselfId}）で作られています。API キーを確認してください: ${path}`,
    );
  }

  const interpretations = validInterpretations(state, byId);
  const built = buildThreads(comments, { myselfId: myself.id, interpretations });

  const refs = await refsOf(ctx.repoDir, pullRequest);
  const locationCache = new Map<number, Promise<CommentLocation | null>>();
  const locate = (comment: BacklogComment) => {
    if (!locationCache.has(comment.id)) locationCache.set(comment.id, locateComment(ctx.repoDir, comment, refs.branchCommit));
    return locationCache.get(comment.id)!;
  };
  const toSnapshotComment = async (comment: BacklogComment): Promise<SnapshotComment> => ({
    id: comment.id,
    author: { id: comment.createdUser.id, name: comment.createdUser.name },
    created: comment.created,
    updated: comment.updated,
    role: built.roles.get(comment.id) ?? "ignored",
    content: comment.content ?? "",
    location: await locate(comment),
  });

  const items: SnapshotItem[] = [];
  for (const thread of built.threads) {
    const root = byId.get(thread.rootId)!;
    const followUps = await Promise.all(thread.followUpIds.map((id) => toSnapshotComment(byId.get(id)!)));
    const item = thread.item;
    const rootSnapshot = await toSnapshotComment(root);
    const botReplies = await Promise.all(
      item.events.flatMap((e) =>
        e.type === "bot_reply" ? [toSnapshotComment(byId.get(e.commentId)!).then((c) => ({ ...c, status: e.status }))] : [],
      ),
    );
    const history: HistoryEntry[] = [rootSnapshot, ...followUps, ...botReplies].sort((a, b) => a.id - b.id);
    const stored = interpretations.get(item.key);
    const valid = stored !== undefined && isInterpretationValid(stored, root, item.lastHumanCommentId);
    items.push({
      key: item.key,
      label: label(item.key),
      status: item.status,
      root: rootSnapshot,
      followUps,
      history,
      botReplyIds: item.events.filter((e) => e.type === "bot_reply").map((e) => e.commentId),
      replyToId: item.lastHumanCommentId,
      interpretation: valid ? stored : null,
      previousInterpretation: !valid && stored !== undefined ? stored : null,
      needsInterpretation: item.status === "open" && !valid,
      contexts: item.status === "open" && !valid ? await itemContexts(ctx.repoDir, refs, root, rootSnapshot, followUps.at(-1)) : [],
      editedAfterReply: thread.editedAfterReply,
      // 状態ファイルがなくても、自分の自動返信から読み戻せるようにする（§5-1 の 6）
      commits: mergeCommits(
        (state.commits[item.key] ?? []).filter(isObjectId),
        botReplies.flatMap((r) => parseReplyFields(r.content).commits),
      ),
      lastReplyLocation: botReplies.length > 0 ? parseReplyFields(botReplies.at(-1)!.content).location : null,
      rootCategory: parseCategoryLine(rootSnapshot.content),
      lastReplyCategory: botReplies.length > 0 ? parseReplyFields(botReplies.at(-1)!.content).category : null,
    });
  }

  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;

  const files = await changedFiles(ctx.repoDir, refs.base, refs.branch);
  const unsafePaths = [
    ...new Set([
      ...files.flatMap((f) => [f.path, f.oldPath ?? ""]),
      ...items.flatMap((i) => [i.root, ...i.followUps].map((c) => c.location?.filePath ?? "")),
    ]),
  ].filter((p) => p !== "" && isUnsafePath(p));
  const conventionChanges = files.map((f) => f.path).filter(isConventionFile);
  const warnings = [
    ...built.warnings,
    ...conventionChanges.map((p) => ({
      commentId: 0,
      message: `この PR で規約のファイルが変更されています（確認①で利用者に伝えること）: ${JSON.stringify(p)}`,
    })),
    ...unsafePaths.map((p) => ({ commentId: 0, message: `シェルで安全に扱えないパスがあります（このファイルには触れません）: ${JSON.stringify(p)}` })),
  ];

  const now = new Date().toISOString();
  const snapshot: Snapshot = {
    generatedAt: now,
    pr: {
      ...pr,
      url: pullRequestUrl(pr),
      summary: pullRequest.summary,
      base: pullRequest.base,
      branch: pullRequest.branch,
      status: pullRequest.status?.name ?? "",
    },
    myself: { id: myself.id, name: myself.name },
    refs,
    changedFiles: files,
    summaryCommentId: built.summaryCommentId,
    warnings,
    unsafePaths,
    conventionChanges,
    counts,
    items,
  };

  // Backlog の内容を正として上書きする（§5-1）
  state.myselfId = myself.id;
  state.syncedAt = now;
  state.lastCommentId = comments.reduce<number | null>((max, c) => (max === null || c.id > max ? c.id : max), null);
  state.summaryCommentId = built.summaryCommentId;
  state.interpretations = Object.fromEntries(interpretations);
  await saveJsonAtomic(path, state);
  await saveJsonAtomic(snapshotPath(ctx.stateRoot, pr), snapshot);
  return { snapshot, state, fetched: { myself, pullRequest, comments } };
}

/**
 * ブランチ名は PR の作成者が決められる値で、スキルがシェルのコマンドに埋め込む。
 * git のブランチ名には `$` や `(` も使えるため、安全な文字だけに限る（§6）
 */
export function assertSafeBranchName(name: string): void {
  if (!/^[A-Za-z0-9._+/-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
    throw new Error(`ブランチ名に使えない文字が含まれているため中止しました: ${JSON.stringify(name)}`);
  }
}

export async function refsOf(repoDir: string, pullRequest: BacklogPullRequest): Promise<Snapshot["refs"]> {
  assertSafeBranchName(pullRequest.base);
  assertSafeBranchName(pullRequest.branch);
  const base = `origin/${pullRequest.base}`;
  const branch = `origin/${pullRequest.branch}`;
  return { base, branch, baseCommit: await resolveRef(repoDir, base), branchCommit: await resolveRef(repoDir, branch) };
}
