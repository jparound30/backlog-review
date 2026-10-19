import { parseBodyMarkers } from "../context.js";
import {} from "../git/diff.js";
import { firstLine, parseReplyBody, parseReplyFields } from "../reply/format.js";
import { parseFindingMarker } from "../review/finding.js";
import { parseCategoryLine } from "../thread/category.js";
import { hasSummaryMarker, isWithdrawal, label } from "../thread/marker.js";
import { buildThreads } from "../thread/thread.js";
/**
 * 自動レビューの指摘なら `指摘:`・`質問:` の行を、なければ最初の行を要約にする。
 * 記録なので、長くても省略しない（§5-2）
 */
function summaryOf(content) {
    const line = parseFindingMarker(content)
        ? content.split("\n").find((l) => l.startsWith("指摘:") || l.startsWith("質問:"))
        : undefined;
    return firstLine(line ? line.replace(/^(?:指摘|質問):\s*/, "") : content, Infinity);
}
function sameCommit(a, b) {
    return a.startsWith(b) || b.startsWith(a);
}
export async function buildRecords(input) {
    // 記録は表示のためだけに使うので、返信マーカーは投稿者を限定せずに読む（§5-2）
    const built = buildThreads(input.comments, {
        myselfId: input.myselfId,
        interpretations: input.interpretations,
        readOthersReplyMarkers: true,
    });
    const byId = new Map(input.comments.map((c) => [c.id, c]));
    const prLabel = `${input.pr.projectKey}/${input.pr.repoName}#${input.pr.number}`;
    const records = [];
    const excluded = [];
    let hiddenNotActionable = 0;
    for (const thread of built.threads) {
        const root = byId.get(thread.rootId);
        const content = root.content ?? "";
        // 他人のサマリーと「指摘なし」は指摘ではない。黙って消さず、注記に出す（§5-2）
        if (hasSummaryMarker(content)) {
            excluded.push({ id: root.id, reason: "summary" });
            continue;
        }
        const finding = parseFindingMarker(content);
        if (finding?.severity === "none") {
            excluded.push({ id: root.id, reason: "no_findings" });
            continue;
        }
        const item = thread.item;
        if (item.status === "not_actionable" && !input.all) {
            hiddenNotActionable++;
            continue;
        }
        const replies = item.events.flatMap((e) => (e.type === "bot_reply" ? [{ comment: byId.get(e.commentId), status: e.status }] : []));
        const last = replies.at(-1);
        const lastFields = last ? parseReplyFields(last.comment.content ?? "") : null;
        const interp = input.interpretations.get(item.key);
        const rootCategory = parseCategoryLine(content);
        const [category, categoryFrom] = rootCategory
            ? [rootCategory, "root"]
            : lastFields?.category
                ? [lastFields.category, "reply"]
                : interp?.category
                    ? [interp.category, "interpretation"]
                    : [null, null];
        const lineComment = await input.locate(root);
        const placed = (interp?.points ?? []).find((p) => p.location.path);
        const location = lineComment && !lineComment.error && lineComment.line !== null
            ? (() => {
                // ファイルが更新されていれば、差分から求めた現在の行番号を使う（返信・サマリーと同じ）
                const line = lineComment.outdated ? lineComment.currentLine : lineComment.line;
                return { path: lineComment.filePath, line, estimated: lineComment.outdated && line === null };
            })()
            : placed
                ? { path: placed.location.path, line: placed.location.line, estimated: placed.location.judgment !== "explicit" }
                : (lastFields?.location ??
                    // 最後に、本文の `場所:` の行（自動レビューの指摘や、レビュアーが書いたもの）
                    (() => {
                        const marker = parseBodyMarkers(content)[0];
                        return marker ? { path: marker.path, line: marker.line, estimated: false } : null;
                    })());
        const commits = [];
        for (const sha of [...replies.flatMap((r) => parseReplyFields(r.comment.content ?? "").commits), ...(input.stateCommits[item.key] ?? [])]) {
            if (/^[0-9a-f]{7,64}$/.test(sha) && !commits.some((c) => sameCommit(c, sha)))
                commits.push(sha.slice(0, 7));
        }
        const lastResolve = item.status === "resolved" ? item.events.findLast((e) => e.type === "resolve") : undefined;
        const resolveComment = lastResolve ? byId.get(lastResolve.commentId) : undefined;
        records.push({
            pr: prLabel,
            key: label(item.key),
            rootId: root.id,
            createdAt: root.created,
            reviewer: root.createdUser?.name ?? "",
            source: finding ? "auto_review" : "human",
            severity: finding ? finding.severity : null,
            category,
            categoryFrom,
            summary: summaryOf(content),
            body: content,
            location,
            status: item.status,
            lastReplyStatus: last?.status ?? null,
            outcome: resolveComment && isWithdrawal(resolveComment.content ?? "") ? "withdrawn" : (last?.status ?? null),
            response: last ? parseReplyBody(last.comment.content ?? "") : null,
            commits,
            lastReplyAt: last?.comment.created ?? null,
            lastReplyId: last?.comment.id ?? null,
            resolvedAt: resolveComment?.created ?? null,
            resolvedBy: resolveComment?.createdUser?.name ?? null,
            botReplies: replies.length,
            followUps: item.events.filter((e) => e.type === "follow_up").length,
            everFixed: replies.some((r) => r.status === "fixed"),
            history: [
                { commentId: root.id, at: root.created, author: root.createdUser?.name ?? "", kind: "review", body: content },
                ...item.events.map((e) => {
                    const c = byId.get(e.commentId);
                    return {
                        commentId: c.id,
                        at: c.created,
                        author: c.createdUser?.name ?? "",
                        kind: e.type,
                        ...(e.type === "bot_reply" ? { status: e.status } : {}),
                        body: c.content ?? "",
                    };
                }),
            ].sort((a, b) => a.commentId - b.commentId),
            url: `${input.prUrl}#comment-${root.id}`,
        });
    }
    return { records: records.sort((a, b) => a.rootId - b.rootId), excluded, hiddenNotActionable };
}
