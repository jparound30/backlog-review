import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/**
 * git をシェルを介さずに実行する。
 * `okExitCodes` に含まれない終了コードはエラーにする（git diff --no-index は差分ありで 1 を返す）。
 */
export async function runGit(repoDir, args, okExitCodes = [0], extraEnv = {}) {
    // 子プロセスに API キーを渡さない
    const { BACKLOG_API_KEY: _, ...env } = process.env;
    try {
        const { stdout } = await execFileAsync("git", args, {
            cwd: repoDir,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...env, ...extraEnv },
        });
        return { stdout, exitCode: 0 };
    }
    catch (error) {
        const e = error;
        if (typeof e.code === "number" && okExitCodes.includes(e.code)) {
            return { stdout: e.stdout ?? "", exitCode: e.code };
        }
        const stderr = (e.stderr ?? "").trim();
        throw new Error(`git ${args.join(" ")} に失敗しました${stderr ? `: ${stderr}` : ""}`);
    }
}
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export function isObjectId(value) {
    return typeof value === "string" && OBJECT_ID.test(value);
}
const memo = new Map();
/**
 * 1 回の実行の中で、同じ問い合わせの結果を使い回す（R-17）。
 * 内容が変わらないもの（blob やコミットの ID で決まるもの）にだけ使う。失敗した結果は覚えない
 */
export function remember(key, make) {
    let found = memo.get(key);
    if (!found) {
        found = make();
        memo.set(key, found);
        found.catch(() => memo.delete(key));
    }
    return found;
}
/** blob の内容を読む。手元にない場合は git fetch を促すエラーにする */
export function readBlob(repoDir, blobId) {
    if (!isObjectId(blobId))
        return Promise.reject(new Error(`blob ID の形式ではありません: ${blobId}`));
    return remember(`blob\0${repoDir}\0${blobId}`, async () => {
        const result = await runGit(repoDir, ["cat-file", "blob", blobId], [0, 128]);
        if (result.exitCode !== 0) {
            throw new Error(`blob ${blobId} が手元のリポジトリにありません。対象リポジトリで git fetch を実行してください`);
        }
        return result.stdout;
    });
}
/**
 * `ref:path` の blob ID を返す。ファイルがなければ null。
 * ref がコミットの ID なら結果は変わらないので使い回す（ブランチ名は動きうるので使い回さない）
 */
export function blobIdAt(repoDir, ref, path) {
    const lookup = async () => {
        const result = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}:${path}`], [0, 1, 128]);
        const id = result.stdout.trim();
        return result.exitCode === 0 && isObjectId(id) ? id : null;
    };
    return isObjectId(ref) ? remember(`path\0${repoDir}\0${ref}\0${path}`, lookup) : lookup();
}
/** 作業ディレクトリのリポジトリのルート（worktree ならその worktree のルート） */
export async function repositoryRoot(dir) {
    const result = await runGit(dir, ["rev-parse", "--show-toplevel"], [0, 128]);
    if (result.exitCode !== 0)
        throw new Error(`${dir} は git リポジトリではありません`);
    return result.stdout.trim();
}
