/**
 * レビューする側の状態ファイル（plan-review.md §4-1）。
 * 対応側の `…pr{N}.json` とは別のファイルにし、同じ clone で両方を動かしても壊れないようにする。
 * 正は Backlog のコメントで、これは投稿の記録とキャッシュにすぎない
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PullRequestRef } from "../backlog/url.ts";
import { assertNotSymlink, STATE_ROOT } from "../state/store.ts";
import type { FindingInput, FindingSeverity } from "./finding.ts";

export type PostedFinding = {
  commentId: number;
  path: string | null;
  line: number | null;
  severity: FindingSeverity;
  title: string;
  postedAt: string;
};

/** draft が作った下書き 1 件。`none` は「指摘なし」のコメント */
export type Draft = {
  id: string;
  severity: FindingSeverity;
  finding: FindingInput | null;
  body: string;
  warnings: string[];
};

export type ReviewState = {
  version: 1;
  kind: "review";
  pr: PullRequestRef;
  myselfId: number | null;
  syncedAt: string | null;
  /** 投稿した指摘。キーは下書きの ID。再実行での二重投稿を防ぐ */
  posted: Record<string, PostedFinding>;
  /** 最後の draft の結果と、確認①の一覧の並び（select がこの並びで回答を読む） */
  drafts?: { at: string; items: Draft[] };
  /** select の結果（投稿する下書きの ID） */
  selected?: { at: string; ids: string[] };
  /** 確認②（--yes なしの post / resolve）で表示した本文のダイジェスト。--yes はこれと一致するときだけ投稿する */
  shown?: { at: string; digest: string };
  shownResolve?: { at: string; digest: string };
  /** --yes なしの summary で表示した内容のダイジェスト（plan.md §4-5-1） */
  shownSummary?: { at: string; digest: string };
  log: Array<{ at: string; action: string; detail?: string; commentId?: number }>;
};

export function reviewStatePath(root: string, pr: PullRequestRef): string {
  return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.review.json`);
}

export function reviewSnapshotPath(root: string, pr: PullRequestRef): string {
  return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.review.snapshot.json`);
}

export function emptyReviewState(pr: PullRequestRef): ReviewState {
  return { version: 1, kind: "review", pr, myselfId: null, syncedAt: null, posted: {}, log: [] };
}

export async function loadReviewState(path: string, pr: PullRequestRef): Promise<ReviewState> {
  await assertNotSymlink(dirname(path));
  await assertNotSymlink(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyReviewState(pr);
  }
  const data = JSON.parse(text) as Partial<ReviewState>;
  if (data.version !== 1 || data.kind !== "review") throw new Error(`状態ファイルの版が想定外です: ${path}`);
  // 状態ファイルは書き換えられうるので、形だけ確かめて使う（投稿済みの判定は Backlog のコメントとも照らす）
  return { ...emptyReviewState(pr), ...data, posted: data.posted ?? {}, log: data.log ?? [] };
}
