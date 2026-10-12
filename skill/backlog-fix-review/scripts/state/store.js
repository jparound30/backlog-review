import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export const STATE_ROOT = ".review-state";
export function statePath(root, pr) {
    return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.json`);
}
export function snapshotPath(root, pr) {
    return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.snapshot.json`);
}
export function emptyState(pr) {
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
export async function loadState(path, pr) {
    await assertNotSymlink(dirname(path));
    await assertNotSymlink(path);
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        return emptyState(pr);
    }
    const data = JSON.parse(text);
    if (data.version !== 1)
        throw new Error(`状態ファイルの版が想定外です: ${path}`);
    return data;
}
/**
 * シンボリックリンクを拒否する。`.review-state/` は対象リポジトリの中にあるため、
 * リンクをコミットされると、たどった先の任意のファイルを書き換えられてしまう（§6-1）
 */
export async function assertNotSymlink(path) {
    try {
        if ((await lstat(path)).isSymbolicLink()) {
            throw new Error(`シンボリックリンクのため中止しました: ${path}`);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
/**
 * 書き込み途中で止まっても壊れないよう、一時ファイルに書いてから置き換える。
 * 一時ファイルは推測できない名前で、既存のファイル（リンクを含む）があれば作らない
 */
export async function saveJsonAtomic(path, data) {
    const dir = dirname(path);
    await assertNotSymlink(dir);
    await mkdir(dir, { recursive: true });
    await assertNotSymlink(dir);
    await assertNotSymlink(path);
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}
