import { changedFiles, locateComment } from "./git/diff.js";
import { isObjectId, runGit } from "./git/git.js";
import { assessInterpretation, validateInterpretations } from "./interpret/interpretation.js";
import { loadState, saveJsonAtomic, snapshotPath, statePath } from "./state/store.js";
import { isUnsafePath } from "./text.js";
import { itemContexts } from "./context.js";
import { parseReplyFields } from "./reply/format.js";
import { parseCategoryLine } from "./thread/category.js";
import { label } from "./thread/marker.js";
import { buildThreads } from "./thread/thread.js";
/** 同じコミットは、短い ID の一致でまとめる */
export function mergeCommits(known, replied) {
    const merged = [...known];
    for (const sha of replied) {
        if (!merged.some((m) => m.startsWith(sha) || sha.startsWith(m)))
            merged.push(sha);
    }
    return merged;
}
export { isUnsafePath } from "./text.js";
/**
 * 対象リポジトリの規約のファイル（§3-4）。PR で変更されていれば、PR の作成者が
 * エージェントへの指示を書き換えた可能性があるので、利用者に知らせる
 */
export function isConventionFile(path) {
    const name = path.split("/").pop() ?? "";
    return (["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "CONTRIBUTING.md", ".cursorrules"].includes(name) ||
        path === ".github/copilot-instructions.md" ||
        /^\.github\/instructions\//.test(path) ||
        // cc-sdd などは Steering の場所を設定で変えられるので、名前に steering を含むディレクトリも対象にする
        /(^|\/)[^/]*steering[^/]*\//i.test(path) ||
        /(^|\/)\.cursor\/rules\//.test(path) ||
        /(^|\/)\.claude\/(settings(\.local)?\.json|commands\/|agents\/|skills\/)/.test(path));
}
export function pullRequestUrl(pr) {
    return `https://${pr.space}/git/${pr.projectKey}/${pr.repoName}/pullRequests/${pr.number}`;
}
export async function resolveRef(repoDir, ref) {
    const result = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], [0, 1]);
    if (result.exitCode !== 0) {
        throw new Error(`${ref} が対象リポジトリにありません。${repoDir} で git fetch を実行してください`);
    }
    return result.stdout.trim();
}
/** 解釈が今のコメントに対して有効か（root が編集されておらず、新しい人間のコメントもない, §5-1） */
function isInterpretationValid(interp, root, lastHumanCommentId) {
    return root !== undefined && interp.rootUpdated === root.updated && interp.lastHumanCommentId === lastHumanCommentId;
}
/**
 * 状態ファイルの解釈のうち、今のコメントに対して使えるもの。
 * 編集された root の解釈は捨てる。
 * 状態ファイルは書き換えられる可能性があるので、解釈はエージェントの入力と同じ検査をし直し（S-7）、
 * 保存されたランクと返信の状態は使わず、判定から求め直す（§3-3）。
 * 以前の形（分割した key・points のない解釈）は通らないので、解釈し直しになる
 */
export function validInterpretations(state, byId) {
    const interpretations = new Map();
    for (const [key, stored] of Object.entries(state.interpretations)) {
        const interp = stored;
        if (!interp || interp.key !== key)
            continue;
        const { items, errors } = validateInterpretations([{ key: interp.key, category: interp.category, points: interp.points }]);
        if (errors.length > 0 || typeof interp.rootUpdated !== "string" || byId.get(Number(key))?.updated !== interp.rootUpdated)
            continue;
        if (typeof interp.lastHumanCommentId !== "number" || typeof interp.interpretedAt !== "string")
            continue;
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
export async function sync(pr, ctx, prefetched) {
    const [myself, pullRequest, comments] = prefetched
        ? [prefetched.myself, prefetched.pullRequest, prefetched.comments]
        : await Promise.all([ctx.client.getMyself(), ctx.client.getPullRequest(pr), ctx.client.listAllComments(pr)]);
    const byId = new Map(comments.map((c) => [c.id, c]));
    const path = statePath(ctx.stateRoot, pr);
    const state = await loadState(path, pr);
    if (state.myselfId !== null && state.myselfId !== myself.id) {
        throw new Error(`状態ファイルは別のユーザー（id=${state.myselfId}）で作られています。API キーを確認してください: ${path}`);
    }
    const interpretations = validInterpretations(state, byId);
    const built = buildThreads(comments, { myselfId: myself.id, interpretations });
    const refs = await refsOf(ctx.repoDir, pullRequest);
    const locationCache = new Map();
    const locate = (comment) => {
        if (!locationCache.has(comment.id))
            locationCache.set(comment.id, locateComment(ctx.repoDir, comment, refs.branchCommit));
        return locationCache.get(comment.id);
    };
    const toSnapshotComment = async (comment) => ({
        id: comment.id,
        author: { id: comment.createdUser.id, name: comment.createdUser.name },
        created: comment.created,
        updated: comment.updated,
        role: built.roles.get(comment.id) ?? "ignored",
        content: comment.content ?? "",
        location: await locate(comment),
    });
    const items = [];
    for (const thread of built.threads) {
        const root = byId.get(thread.rootId);
        const followUps = await Promise.all(thread.followUpIds.map((id) => toSnapshotComment(byId.get(id))));
        const item = thread.item;
        const rootSnapshot = await toSnapshotComment(root);
        const botReplies = await Promise.all(item.events.flatMap((e) => e.type === "bot_reply" ? [toSnapshotComment(byId.get(e.commentId)).then((c) => ({ ...c, status: e.status }))] : []));
        const history = [rootSnapshot, ...followUps, ...botReplies].sort((a, b) => a.id - b.id);
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
            commits: mergeCommits((state.commits[item.key] ?? []).filter(isObjectId), botReplies.flatMap((r) => parseReplyFields(r.content).commits)),
            lastReplyLocation: botReplies.length > 0 ? parseReplyFields(botReplies.at(-1).content).location : null,
            rootCategory: parseCategoryLine(rootSnapshot.content),
            lastReplyCategory: botReplies.length > 0 ? parseReplyFields(botReplies.at(-1).content).category : null,
        });
    }
    const counts = {};
    for (const item of items)
        counts[item.status] = (counts[item.status] ?? 0) + 1;
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
    const snapshot = {
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
    state.lastCommentId = comments.reduce((max, c) => (max === null || c.id > max ? c.id : max), null);
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
export function assertSafeBranchName(name) {
    if (!/^[A-Za-z0-9._+/-]+$/.test(name) || name.startsWith("-") || name.includes("..")) {
        throw new Error(`ブランチ名に使えない文字が含まれているため中止しました: ${JSON.stringify(name)}`);
    }
}
export async function refsOf(repoDir, pullRequest) {
    assertSafeBranchName(pullRequest.base);
    assertSafeBranchName(pullRequest.branch);
    const base = `origin/${pullRequest.base}`;
    const branch = `origin/${pullRequest.branch}`;
    return { base, branch, baseCommit: await resolveRef(repoDir, base), branchCommit: await resolveRef(repoDir, branch) };
}
