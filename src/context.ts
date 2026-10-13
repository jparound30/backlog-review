import type { BacklogComment } from "./backlog/types.ts";
import { DIFF_OPTIONS } from "./git/diff.ts";
import { blobIdAt, isObjectId, readBlob, remember, runGit } from "./git/git.ts";
import { isRepoRelativePath, isUnsafePath } from "./text.ts";
import type { SnapshotComment } from "./sync.ts";

/** 指摘の周りのコード（§3-2 手順 2, 改善案 A-1）。エージェントが解釈を始めるための出発点 */
export type ItemContext = {
  /** `line_comment`: 行コメントの位置。`body_marker`: 本文の `📍 path L42` から CLI が読んだ場所（場所の判定はエージェントが行う） */
  source: "line_comment" | "body_marker";
  path: string;
  line: number;
  /** どのファイルから切り出したか */
  file: "pr_branch" | "base" | "commented" | "old";
  lines: Array<{ n: number; text: string; target?: true }>;
  /** その行を含む PR の差分の hunk。変更のない行なら null */
  hunk: string | null;
};

const AROUND = 15;
const MAX_CONTEXTS = 3;
const MAX_HUNK_LINES = 60;

/**
 * 本文の場所の印（レビュアー向けのテンプレートの書式, §4-2）。行の先頭の `場所: path L42` と、
 * 以前の書式の `📍 path L42`（絵文字の記法 `:round_pushpin:`・`:pushpin:` を含む, §4-7）を読む
 */
const BODY_MARKER = /(?:^[ \t]*場所[ \t]*[:：]|📍|:round_pushpin:|:pushpin:)\s*`?([^\s`]+)`?\s*[LＬ](\d+)/gm;

export function parseBodyMarkers(content: string): Array<{ path: string; line: number }> {
  const found: Array<{ path: string; line: number }> = [];
  for (const m of content.matchAll(BODY_MARKER)) {
    const path = m[1];
    if (isUnsafePath(path) || !isRepoRelativePath(path)) continue;
    found.push({ path, line: Number(m[2]) });
  }
  return found;
}

function slice(text: string, line: number): ItemContext["lines"] | null {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  if (line < 1 || line > all.length) return null;
  const from = Math.max(1, line - AROUND);
  const to = Math.min(all.length, line + AROUND);
  return all.slice(from - 1, to).map((t, i) => (from + i === line ? { n: from + i, text: t, target: true } : { n: from + i, text: t }));
}

/** PR の差分（base...branch）のうち、指定した行を含む hunk。side が old なら変更前の行で探す */
async function hunkAt(
  repoDir: string,
  refs: { baseCommit: string; branchCommit: string },
  path: string,
  line: number,
  side: "new" | "old",
): Promise<string | null> {
  const diff = await remember(`hunks\0${repoDir}\0${refs.baseCommit}\0${refs.branchCommit}\0${path}`, async () => {
    const { stdout } = await runGit(repoDir, [
      "--literal-pathspecs",
      "diff",
      ...DIFF_OPTIONS,
      "--diff-algorithm=myers",
      "-U3",
      `${refs.baseCommit}...${refs.branchCommit}`,
      "--",
      path,
    ]);
    return stdout;
  });
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!h) continue;
    const [oldStart, oldCount, newStart, newCount] = [Number(h[1]), Number(h[2] ?? 1), Number(h[3]), Number(h[4] ?? 1)];
    // hunk の行は、@@ 行の行数だけ読む（内容が見出しに見えても取り違えない, R-1 と同じ考え方）
    let [oldLeft, newLeft] = [oldCount, newCount];
    const body: string[] = [lines[i]];
    let j = i + 1;
    for (; j < lines.length && (oldLeft > 0 || newLeft > 0); j++) {
      const l = lines[j];
      body.push(l);
      if (l.startsWith("\\")) continue;
      if (l.startsWith("+")) newLeft--;
      else if (l.startsWith("-")) oldLeft--;
      else {
        oldLeft--;
        newLeft--;
      }
    }
    const [start, count] = side === "new" ? [newStart, newCount] : [oldStart, oldCount];
    if (line >= start && line < start + count) {
      return body.length > MAX_HUNK_LINES
        ? [...body.slice(0, MAX_HUNK_LINES), `…（ほか ${body.length - MAX_HUNK_LINES} 行）`].join("\n")
        : body.join("\n");
    }
    i = j - 1;
  }
  return null;
}

/**
 * 解釈が必要な指摘の周りのコードを集める（§3-2 手順 2, 改善案 A-1）。
 * 行コメントの位置と、本文（最新の追加の指示、なければ元のコメント）の `場所:`（以前の書式の `📍` を含む）から、3 か所まで
 */
export async function itemContexts(
  repoDir: string,
  refs: { baseCommit: string; branchCommit: string },
  raw: BacklogComment,
  root: SnapshotComment,
  latestFollowUp: SnapshotComment | undefined,
): Promise<ItemContext[]> {
  const contexts: ItemContext[] = [];
  const loc = root.location;
  if (loc && !loc.error && loc.line !== null) {
    // 指摘された行は blob から切り出す。削除行なら変更前、更新後なら現在のファイルの currentLine
    let blob: string | null | undefined;
    let line = loc.line;
    let file: ItemContext["file"];
    if (loc.side === "old") {
      [blob, file] = [raw.oldBlobId, "old"];
    } else if (loc.outdated && loc.currentLine !== null) {
      [blob, line, file] = [await blobIdAt(repoDir, refs.branchCommit, loc.filePath), loc.currentLine, "pr_branch"];
    } else {
      [blob, file] = [raw.newBlobId, loc.outdated ? "commented" : "pr_branch"];
    }
    const lines = isObjectId(blob) ? slice(await readBlob(repoDir, blob), line) : null;
    if (lines) {
      const hunk = file === "commented" ? null : await hunkAt(repoDir, refs, loc.filePath, line, loc.side === "old" ? "old" : "new");
      contexts.push({ source: "line_comment", path: loc.filePath, line, file, lines, hunk });
    }
  }
  for (const marker of parseBodyMarkers(latestFollowUp?.content ?? root.content)) {
    if (contexts.length >= MAX_CONTEXTS) break;
    if (contexts.some((c) => c.path === marker.path && c.line === marker.line)) continue;
    const onBranch = await blobIdAt(repoDir, refs.branchCommit, marker.path);
    const blob = onBranch ?? (await blobIdAt(repoDir, refs.baseCommit, marker.path));
    const lines = blob ? slice(await readBlob(repoDir, blob), marker.line) : null;
    if (!lines) continue;
    const hunk = onBranch ? await hunkAt(repoDir, refs, marker.path, marker.line, "new") : null;
    contexts.push({ source: "body_marker", path: marker.path, line: marker.line, file: onBranch ? "pr_branch" : "base", lines, hunk });
  }
  return contexts;
}
