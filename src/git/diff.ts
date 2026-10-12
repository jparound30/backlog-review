import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BacklogComment } from "../backlog/types.ts";
import { blobIdAt, isObjectId, readBlob, remember, runGit } from "./git.ts";

export type DiffLineKind = "+" | "-" | " ";

export type DiffLine = {
  /** Backlog の `position` と同じ数え方（§2-1） */
  position: number;
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

/**
 * unified diff を行ごとに分解する。
 * `@@` 行そのものは数えず、その次の行を 1 として `-`・`+`・変更なしの行をすべて数える。
 * "\ No newline at end of file" は数えない。
 */
export function parseDiffLines(diffText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let position = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diffText.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      // 0 行のファイルは "-0,0" と表されるので、次の行が 1 行目になるよう補正する
      if (oldLine === 0) oldLine = 1;
      if (newLine === 0) newLine = 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const kind = raw[0];
    if (kind !== "+" && kind !== "-" && kind !== " ") continue;
    position++;
    const text = raw.slice(1);
    if (kind === "-") {
      lines.push({ position, kind, oldLine: oldLine++, newLine: null, text });
    } else if (kind === "+") {
      lines.push({ position, kind, oldLine: null, newLine: newLine++, text });
    } else {
      lines.push({ position, kind, oldLine: oldLine++, newLine: newLine++, text });
    }
  }
  return lines;
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * ファイル全体を 1 つの hunk にした差分を作る（Backlog の `position` の基準, §2-1）。
 * 新規・削除ファイルにも対応するため、内容を一時ファイルに書き出して比較する。
 */
export async function fullFileDiff(oldText: string, newText: string): Promise<DiffLine[]> {
  const dir = await mkdtemp(join(tmpdir(), "bfr-diff-"));
  try {
    const oldPath = join(dir, "old");
    const newPath = join(dir, "new");
    await writeFile(oldPath, oldText);
    await writeFile(newPath, newText);
    const context = Math.max(countLines(oldText), countLines(newText)) + 1;
    const { stdout } = await runGit(
      dir,
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        // 差分の取り方を、position の実例を確かめたときの git の既定にそろえる（R-9）
        "--diff-algorithm=myers",
        "--indent-heuristic",
        `-U${context}`,
        oldPath,
        newPath,
      ],
      [0, 1],
      // 一時ディレクトリの上位にある git リポジトリやその設定を読まない。
      // 利用者の ~/.gitconfig も読まない（diff.algorithm などで - と + の並びが変わり、行がずれるため, R-9）
      { GIT_CEILING_DIRECTORIES: dirname(dir), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
    );
    return parseDiffLines(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type CommentLocation = {
  filePath: string;
  /** `position` から求めた行。`position` がない場合は null */
  side: "new" | "old" | null;
  line: number | null;
  text: string | null;
  /** コメント後にファイルが更新され、指摘時点の内容と現在のブランチの内容が違う */
  outdated: boolean;
  /** outdated のとき、指摘時点と現在のファイルの差分から求めた現在の行番号 */
  currentLine: number | null;
  /** outdated のとき、指摘された行そのものが変更されている（修正済みの可能性が高い） */
  currentLineChanged: boolean;
  /** 位置を求められなかった理由 */
  error: string | null;
};

/**
 * 2 つの blob のファイル全体の差分。blob の ID がなければ空のファイルとして扱う。
 * 同じファイルへの行コメントは同じ組になることが多いので、1 回の実行の中で使い回す（R-17）
 */
function diffBlobs(repoDir: string, oldId: string | null | undefined, newId: string | null | undefined): Promise<DiffLine[]> {
  const ids = [oldId, newId].map((id) => (isObjectId(id) ? id : null));
  return remember(`diff\0${repoDir}\0${ids[0]}\0${ids[1]}`, async () => {
    const [oldText, newText] = await Promise.all(ids.map((id) => (id ? readBlob(repoDir, id) : "")));
    return fullFileDiff(oldText, newText);
  });
}

/**
 * 行コメントの場所を求める。場所を指定しないコメントなら null を返す。
 * `branchRef` は現在のブランチ（例: origin/feature-x）。コミットの ID を渡すと、ファイルの問い合わせを使い回せる（R-17）。
 */
export async function locateComment(
  repoDir: string,
  comment: BacklogComment,
  branchRef: string,
): Promise<CommentLocation | null> {
  const filePath = comment.filePath;
  if (!filePath) return null;

  const base: CommentLocation = {
    filePath,
    side: null,
    line: null,
    text: null,
    outdated: false,
    currentLine: null,
    currentLineChanged: false,
    error: null,
  };
  if (typeof comment.position !== "number" || comment.position < 1) {
    return { ...base, error: "position がありません" };
  }

  let diff: DiffLine[];
  try {
    diff = await diffBlobs(repoDir, comment.oldBlobId, comment.newBlobId);
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }

  const hit = diff.find((d) => d.position === comment.position);
  if (!hit) {
    return { ...base, error: `position ${comment.position} が差分の範囲外です（差分は ${diff.length} 行）` };
  }

  const side = hit.kind === "-" ? "old" : "new";
  const located: CommentLocation = {
    ...base,
    side,
    line: side === "old" ? hit.oldLine : hit.newLine,
    text: hit.text,
  };

  // 削除行への指摘は、現在のファイルとの突き合わせをしない
  if (side === "old") return located;

  const currentBlob = await blobIdAt(repoDir, branchRef, filePath);
  if (currentBlob === comment.newBlobId) return located;

  located.outdated = true;
  if (currentBlob && located.line !== null) {
    try {
      const mapped = mapLine(await diffBlobs(repoDir, comment.newBlobId, currentBlob), located.line);
      located.currentLine = mapped.line;
      located.currentLineChanged = mapped.changed;
    } catch (error) {
      located.error = error instanceof Error ? error.message : String(error);
    }
  }
  return located;
}

/**
 * 旧ファイルの行番号を、差分を使って新ファイルの行番号に写す。
 * 行が変更・削除されていれば、置き換わった最初の行（なければ直後の行）を指し、changed を true にする。
 */
export function mapLine(diff: DiffLine[], oldLine: number): { line: number | null; changed: boolean } {
  const index = diff.findIndex((d) => d.oldLine === oldLine);
  if (index < 0) return { line: null, changed: false };
  const hit = diff[index];
  if (hit.kind === " ") return { line: hit.newLine, changed: false };
  for (const d of diff.slice(index + 1)) {
    if (d.kind === "+" || d.kind === " ") return { line: d.newLine, changed: true };
  }
  // ファイル末尾の行が削除された
  const lastNew = diff.findLast((d) => d.newLine !== null);
  return { line: lastNew?.newLine ?? null, changed: true };
}

export type LineRange = { start: number; end: number };

export type ChangedFile = {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  /** 変更前のパス（名前の変更なら元の名前）。追加なら null */
  oldPath: string | null;
  /** 変更後のファイルで変更された行の範囲（削除だけの箇所は含まない） */
  newRanges: LineRange[];
};

/** `git diff` の出力を、利用者の git の設定に左右されない形にする */
export const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--submodule=short"];

type NameStatus = Pick<ChangedFile, "path" | "status" | "oldPath">;

/**
 * `git diff --name-status -z` の出力を読む。
 * パスは差分の見出し（`+++ b/…`）から取らない。見出しのパスは、日本語なら `"b/\346…"` と引用され、
 * 空白を含めば行末にタブが付くため、そのままでは使えない（R-3）
 */
export function parseNameStatus(output: string): NameStatus[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: NameStatus[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++][0];
    if (code === "R" || code === "C") {
      const [from, to] = [fields[i++], fields[i++]];
      // 複製の元のファイルは変わらないので、複製先を追加として扱う
      entries.push(code === "R" ? { path: to, status: "renamed", oldPath: from } : { path: to, status: "added", oldPath: null });
    } else {
      const path = fields[i++];
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      entries.push({ path, status, oldPath: status === "added" ? null : path });
    }
  }
  return entries;
}

export type FilePatch = {
  newRanges: LineRange[];
  /** 追加行の内容（先頭の `+` を除く） */
  added: string[];
};

/**
 * `-U0` などの差分を、ファイルごとに分ける。
 * hunk の中の行は `@@` 行に書かれた行数だけ読むので、追加した行の内容が `++ /dev/null` や
 * `diff --git …` でも、ファイルの見出しと取り違えない（R-1）
 */
export function parsePatch(diffText: string): FilePatch[] {
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diffText.split("\n")) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (raw.startsWith("\\")) continue;
      if (raw.startsWith("+") && newLeft > 0) {
        current.added.push(raw.slice(1));
        newLeft--;
        continue;
      }
      if (raw.startsWith("-") && oldLeft > 0) {
        oldLeft--;
        continue;
      }
      // 変更なしの行（diff.suppressBlankEmpty なら空行）
      if ((raw.startsWith(" ") || raw === "") && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        continue;
      }
      // 行数が合わない。hunk はここで終わったものとして、見出しとして読み直す
      oldLeft = newLeft = 0;
    }
    if (raw.startsWith("diff --git ")) {
      current = { newRanges: [], added: [] };
      files.push(current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (current && hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const start = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (newLeft > 0) current.newRanges.push({ start, end: start + newLeft - 1 });
    }
  }
  return files;
}

export type DiffFile = NameStatus & FilePatch;

/**
 * 2 つの範囲の変更ファイルと、ファイルごとの変更行・追加行。
 * パスは `--name-status -z` から、行は `-U0` の差分から取り、同じ順に並ぶことを使って突き合わせる
 */
export async function diffFiles(
  repoDir: string,
  range: string[],
  options: { renames: boolean; text?: boolean },
): Promise<DiffFile[]> {
  const common = [...DIFF_OPTIONS, options.renames ? "-M" : "--no-renames"];
  const [names, patch] = await Promise.all([
    runGit(repoDir, ["diff", ...common, "--name-status", "-z", ...range, "--"]),
    runGit(repoDir, ["diff", ...common, ...(options.text ? ["--text"] : []), "-U0", ...range, "--"]),
  ]);
  const entries = parseNameStatus(names.stdout);
  const patches = parsePatch(patch.stdout);
  if (entries.length !== patches.length) {
    throw new Error(`差分の解析に失敗しました（ファイル ${entries.length} 件に対し、差分 ${patches.length} 件）`);
  }
  return entries.map((entry, i) => ({ ...entry, ...patches[i] }));
}

/** PR の変更ファイルと変更行の範囲（`git diff -U0 base...branch`） */
export async function changedFiles(repoDir: string, baseRef: string, branchRef: string): Promise<ChangedFile[]> {
  const files = await diffFiles(repoDir, [`${baseRef}...${branchRef}`], { renames: true });
  return files.map(({ path, status, oldPath, newRanges }) => ({ path, status, oldPath, newRanges }));
}
