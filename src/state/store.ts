import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PullRequestRef } from "../backlog/url.ts";
import type { StoredInterpretation } from "../interpret/interpretation.ts";
import type { ItemKey } from "../thread/marker.ts";

/**
 * ローカルの状態（§5）。正は Backlog のコメントで、これはキャッシュと記録にすぎない。
 * 失っても `fetch` で作り直せる（解釈だけはやり直しになる）。
 */
export type LocalState = {
  version: 1;
  pr: PullRequestRef;
  myselfId: number | null;
  syncedAt: string | null;
  lastCommentId: number | null;
  summaryCommentId: number | null;
  interpretations: Record<ItemKey, StoredInterpretation>;
  /** 指摘ごとの修正コミット（§3-2 手順 5） */
  commits: Record<ItemKey, string[]>;
  log: Array<{ at: string; action: string; key?: ItemKey; commentId?: number; detail?: string }>;
  /** 確認①の一覧の番号の並び（interpret が出したもの）。select が回答を読むのに使う（§8 M11） */
  listed?: { at: string; keys: ItemKey[] };
};

export const STATE_ROOT = ".review-state";

export function statePath(root: string, pr: PullRequestRef): string {
  return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.json`);
}

export function snapshotPath(root: string, pr: PullRequestRef): string {
  return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.snapshot.json`);
}

export function emptyState(pr: PullRequestRef): LocalState {
  return {
    version: 1,
    pr,
    myselfId: null,
    syncedAt: null,
    lastCommentId: null,
    summaryCommentId: null,
    interpretations: {},
    commits: {},
    log: [],
  };
}

export async function loadState(path: string, pr: PullRequestRef): Promise<LocalState> {
  await assertNotSymlink(dirname(path));
  await assertNotSymlink(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyState(pr);
  }
  const data = JSON.parse(text) as LocalState;
  if (data.version !== 1) throw new Error(`状態ファイルの版が想定外です: ${path}`);
  return data;
}

/**
 * シンボリックリンクを拒否する。`.review-state/` は対象リポジトリの中にあるため、
 * リンクをコミットされると、たどった先の任意のファイルを書き換えられてしまう（§6-1）
 */
export async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`シンボリックリンクのため中止しました: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * 書き込み途中で止まっても壊れないよう、一時ファイルに書いてから置き換える。
 * 一時ファイルは推測できない名前で、既存のファイル（リンクを含む）があれば作らない
 */
export async function saveJsonAtomic(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await assertNotSymlink(dir);
  await mkdir(dir, { recursive: true });
  await assertNotSymlink(dir);
  await assertNotSymlink(path);
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
