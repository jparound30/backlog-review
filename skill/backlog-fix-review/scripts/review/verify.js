/**
 * 再レビュー（plan-review.md §4-6）: 対応側の返信とコミットを突き合わせ、エージェントが判断する材料をそろえる。
 * 解決・再指摘の判断はエージェントと利用者が行い、CLI は事実（コミットの存在・差分・現在の行）を示すだけ
 */
import { DIFF_OPTIONS, parsePatch } from "../git/diff.js";
import { blobIdAt, readBlob, runGit } from "../git/git.js";
import { isPushed } from "../commands.js";
const AROUND = 5;
const MAX_DIFF_LINES = 120;
/** 返信に書かれたコミットを調べる上限。偽の返信に大量に書かれても git の起動が増えすぎないようにする */
const MAX_COMMITS = 20;
/** 指摘の行とコミットの変更行が「近い」とみなす差 */
const NEAR_LINES = 3;
function placeOf(item) {
    const reply = item.lastBotReply?.location;
    const loc = item.root.location;
    const lineComment = loc && !loc.error ? { path: loc.filePath, line: loc.outdated ? loc.currentLine : loc.line } : null;
    // 返信の場所（対応側が行を追跡したもの）を優先する。返信に行番号がなければ、行コメントの行で補う
    if (reply)
        return { path: reply.path, line: reply.line ?? (lineComment?.path === reply.path ? lineComment.line : null) };
    if (lineComment)
        return lineComment;
    const m = item.root.bodyMarkers[0];
    return m ? { path: m.path, line: m.line } : null;
}
async function verifyCommit(repoDir, refs, sha, path) {
    // 短い ID が曖昧なときは 128 で終わる。見つからないものとして扱う
    const resolved = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], [0, 1, 128]);
    if (resolved.exitCode !== 0)
        return { sha, found: false, pushed: false, subject: "", files: [], diff: null, diffTruncated: false, changedRanges: [] };
    const full = resolved.stdout.trim();
    const [pushed, subject, names] = await Promise.all([
        isPushed(repoDir, full, refs.branchCommit, refs.baseCommit),
        runGit(repoDir, ["log", "-1", "--format=%s", full]).then((r) => r.stdout.trim()),
        runGit(repoDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", full]).then((r) => r.stdout.split("\0").filter(Boolean)),
    ]);
    const target = path && names.includes(path) ? ["--", path] : [];
    const [show, ranges] = await Promise.all([
        runGit(repoDir, ["--literal-pathspecs", "show", ...DIFF_OPTIONS, "--format=", "--diff-algorithm=myers", "-U3", full, ...target]),
        target.length > 0
            ? runGit(repoDir, ["--literal-pathspecs", "show", ...DIFF_OPTIONS, "--format=", "--diff-algorithm=myers", "-U0", full, ...target]).then((r) => parsePatch(r.stdout).flatMap((f) => f.newRanges))
            : Promise.resolve([]),
    ]);
    const lines = show.stdout.split("\n");
    return {
        sha: full,
        found: true,
        pushed,
        subject,
        files: names,
        diff: lines.slice(0, MAX_DIFF_LINES).join("\n"),
        diffTruncated: lines.length > MAX_DIFF_LINES,
        changedRanges: ranges,
    };
}
async function currentLines(repoDir, refs, place) {
    if (!place || place.line === null)
        return null;
    const blob = await blobIdAt(repoDir, refs.branchCommit, place.path);
    if (!blob)
        return null;
    const all = (await readBlob(repoDir, blob)).split("\n");
    if (all.at(-1) === "")
        all.pop();
    if (place.line < 1 || place.line > all.length)
        return null;
    const from = Math.max(1, place.line - AROUND);
    const to = Math.min(all.length, place.line + AROUND);
    return all.slice(from - 1, to).map((t, i) => (from + i === place.line ? { n: from + i, text: t, target: true } : { n: from + i, text: t }));
}
/** レビュアーの番になっている指摘について、返信の裏付けを集める */
export async function verifyItems(repoDir, snapshot) {
    const result = [];
    for (const item of snapshot.items.filter((i) => i.awaitingReviewer)) {
        const reply = item.lastBotReply;
        const place = placeOf(item);
        const warnings = [];
        const commits = [];
        for (const sha of reply.commits.slice(0, MAX_COMMITS))
            commits.push(await verifyCommit(repoDir, snapshot.refs, sha, place?.path ?? null));
        if (reply.commits.length > MAX_COMMITS)
            warnings.push(`返信のコミットが ${reply.commits.length} 件あります。先頭の ${MAX_COMMITS} 件だけ調べました`);
        if (reply.status === "fixed") {
            if (commits.length === 0)
                warnings.push("fixed の返信にコミットがありません");
            for (const c of commits) {
                if (!c.found)
                    warnings.push(`コミット ${c.sha} が手元にありません（git fetch が必要か、存在しないコミット）`);
                else if (!c.pushed)
                    warnings.push(`コミット ${c.sha.slice(0, 7)} は PR のブランチに push されていません`);
                else if (place && !c.files.includes(place.path))
                    warnings.push(`コミット ${c.sha.slice(0, 7)} は指摘のファイル（${place.path}）を変更していません`);
            }
            // どのコミットも指摘の行の近くを変えていなければ、直っていない可能性がある（plan-review.md §4-6）
            const touching = commits.filter((c) => c.found && c.files.includes(place?.path ?? ""));
            if (place?.line !== null && place?.line !== undefined && touching.length > 0) {
                const line = place.line;
                const near = touching.some((c) => c.changedRanges.some((r) => line >= r.start - NEAR_LINES && line <= r.end + NEAR_LINES));
                if (!near)
                    warnings.push(`コミットは指摘の行（L${line}）の近くを変更していません。直っているか差分で確かめること`);
            }
        }
        if (reply.byOthers)
            warnings.push(`返信の投稿者（${reply.author.name}）は PR の作成者ではありません`);
        if (!item.mine)
            warnings.push("自分の指摘ではありません（人間のレビュアーの指摘）。解決するなら利用者にその旨を示すこと");
        if (item.editedAfterReply)
            warnings.push("返信の後に元の指摘が編集されています");
        result.push({ item, place, commits, current: await currentLines(repoDir, snapshot.refs, place), warnings });
    }
    return result;
}
