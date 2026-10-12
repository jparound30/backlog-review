/**
 * レビューする側の状態ファイル（plan-review.md §4-1）。
 * 対応側の `…pr{N}.json` とは別のファイルにし、同じ clone で両方を動かしても壊れないようにする。
 * 正は Backlog のコメントで、これは投稿の記録とキャッシュにすぎない
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertNotSymlink, STATE_ROOT } from "../state/store.js";
export function reviewStatePath(root, pr) {
    return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.review.json`);
}
export function reviewSnapshotPath(root, pr) {
    return join(root, STATE_ROOT, `${pr.projectKey}-${pr.repoName}-pr${pr.number}.review.snapshot.json`);
}
export function emptyReviewState(pr) {
    return { version: 1, kind: "review", pr, myselfId: null, syncedAt: null, posted: {}, log: [] };
}
export async function loadReviewState(path, pr) {
    await assertNotSymlink(dirname(path));
    await assertNotSymlink(path);
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch {
        return emptyReviewState(pr);
    }
    const data = JSON.parse(text);
    if (data.version !== 1 || data.kind !== "review")
        throw new Error(`状態ファイルの版が想定外です: ${path}`);
    // 状態ファイルは書き換えられうるので、形だけ確かめて使う（投稿済みの判定は Backlog のコメントとも照らす）
    return { ...emptyReviewState(pr), ...data, posted: data.posted ?? {}, log: data.log ?? [] };
}
