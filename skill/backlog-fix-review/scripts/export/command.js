/**
 * `export <URL> [--all]`（§5-2）。両方のスキルの CLI から使う（§7-11）。
 * 読み取りだけで、Backlog には何も投稿せず、作業ツリーも状態ファイルも変えない
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { locateComment } from "../git/diff.js";
import { isObjectId } from "../git/git.js";
import { assertNotSymlink, loadState, STATE_ROOT, statePath } from "../state/store.js";
import { pullRequestUrl, refsOf, validInterpretations } from "../sync.js";
import { formatCsv, formatMarkdown } from "./format.js";
import { buildRecords } from "./record.js";
function stamp(date, offsetMinutes) {
    const offset = offsetMinutes ?? -date.getTimezoneOffset();
    const local = new Date(date.getTime() + offset * 60_000);
    const p = (n) => String(n).padStart(2, "0");
    return `${local.getUTCFullYear()}${p(local.getUTCMonth() + 1)}${p(local.getUTCDate())}-${p(local.getUTCHours())}${p(local.getUTCMinutes())}${p(local.getUTCSeconds())}`;
}
export function exportDir(stateRoot) {
    return join(stateRoot, STATE_ROOT, "export");
}
/**
 * Backlog から取り直したコメントで記録を組み立てる（§5-2）。読むだけで、何も書かない。
 * サマリー（§4-5-1）も、どちらのスキルで作っても同じ内容になるよう、これを使う
 */
export async function collectRecords(pr, ctx, options) {
    const [myself, pullRequest, comments] = await Promise.all([
        ctx.client.getMyself(),
        ctx.client.getPullRequest(pr),
        ctx.client.listAllComments(pr),
    ]);
    const byId = new Map(comments.map((c) => [c.id, c]));
    const refs = await refsOf(ctx.repoDir, pullRequest);
    const notes = [];
    let interpretations = new Map();
    let stateCommits = {};
    if (options.useFixState) {
        const path = statePath(ctx.stateRoot, pr);
        try {
            // 読むだけ。ファイルがなければ空の状態になり、作らない
            const state = await loadState(path, pr);
            if (state.myselfId !== null && state.myselfId !== myself.id) {
                notes.push("状態ファイルは別のユーザーが作ったものなので使っていません");
            }
            else {
                interpretations = validInterpretations(state, byId);
                stateCommits = Object.fromEntries(Object.entries(state.commits ?? {}).map(([k, shas]) => [k, (shas ?? []).filter(isObjectId)]));
            }
        }
        catch (error) {
            notes.push(`状態ファイルを読めないので使っていません（${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    else {
        notes.push("レビュー側で出力したため、まだ自動返信のない指摘の分類と not_actionable の判定は補っていません（対応側で出すと補えます）");
    }
    const prUrl = pullRequestUrl(pr);
    const result = await buildRecords({
        pr,
        prUrl,
        comments,
        myselfId: myself.id,
        locate: (comment) => locateComment(ctx.repoDir, comment, refs.branchCommit),
        interpretations,
        stateCommits,
        all: options.all,
    });
    return { result, myself, pullRequest, comments, prUrl, notes };
}
export async function exportCommand(pr, ctx, options) {
    const { result, pullRequest, prUrl, notes } = await collectRecords(pr, ctx, options);
    const now = options.now ?? new Date();
    const csv = formatCsv(result.records, { apiKey: options.apiKey, offsetMinutes: options.offsetMinutes });
    const md = formatMarkdown(result, {
        prUrl,
        title: pullRequest.summary,
        generatedAt: now.toISOString(),
        skill: options.skill,
        notes,
        apiKey: options.apiKey,
        offsetMinutes: options.offsetMinutes,
    });
    // 出力先は固定する（誘導されたエージェントに任意のファイルを書き換えさせない, §5-2）
    const dir = exportDir(ctx.stateRoot);
    await assertNotSymlink(join(ctx.stateRoot, STATE_ROOT));
    await mkdir(dir, { recursive: true });
    await assertNotSymlink(join(ctx.stateRoot, STATE_ROOT));
    await assertNotSymlink(dir);
    const base = join(dir, `${pr.projectKey}-${pr.repoName}-pr${pr.number}-${stamp(now, options.offsetMinutes)}`);
    const csvPath = `${base}.csv`;
    const mdPath = `${base}.md`;
    try {
        await writeFile(csvPath, csv, { flag: "wx", mode: 0o600 });
        await writeFile(mdPath, md, { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw new Error(`同じ名前のファイルがあるため書きませんでした。少し待ってからやり直してください: ${base}`);
        throw error;
    }
    const counted = result.records.filter((r) => r.status !== "not_actionable");
    ctx.out(`対応の記録を出力しました（指摘 ${counted.length} 件、うち完了 ${counted.filter((r) => r.status === "resolved").length} 件）:`);
    ctx.out(`  ${csvPath}`);
    ctx.out(`  ${mdPath}`);
    for (const note of notes)
        ctx.out(`  注記: ${note}`);
    ctx.out("出力には指摘者の名前とコメントの本文が入ります。共有するときは中身を確かめてください（.review-state/ の下はコミットしないこと）");
    return { csv: csvPath, md: mdPath };
}
