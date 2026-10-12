import { hasSummaryMarker, parseItemKey, parseReference, parseReplyMarker, } from "./marker.js";
/**
 * コメント一覧からスレッドを組み立て、指摘ごとの状態を求める（§4, §4-6）。
 * Backlog のコメントだけから決まるので、ローカルの状態が消えても同じ結果になる。
 */
export function buildThreads(comments, options) {
    const sorted = [...comments].sort((a, b) => a.id - b.id);
    const commentById = new Map(sorted.map((c) => [c.id, c]));
    const roles = new Map();
    const warnings = [];
    const rootOf = new Map();
    const threads = new Map();
    let summaryCommentId = null;
    const addEvent = (rootId, event) => {
        const thread = threads.get(rootId);
        if (!thread)
            return;
        thread.events.push(event);
        rootOf.set(event.commentId, rootId);
    };
    for (const comment of sorted) {
        const content = comment.content ?? "";
        const isMine = comment.createdUser?.id === options.myselfId;
        // 自分の ID ＋マーカーありだけを Bot のコメントとみなす（他人のマーカーは信用しない, §4-6）
        if (isMine && hasSummaryMarker(content)) {
            roles.set(comment.id, "summary");
            summaryCommentId ??= comment.id;
            continue;
        }
        const marker = isMine || options.readOthersReplyMarkers ? parseReplyMarker(content) : null;
        if (marker) {
            roles.set(comment.id, "bot_reply");
            const key = parseItemKey(marker.root);
            if (!key || !threads.has(key.rootId)) {
                warnings.push({ commentId: comment.id, message: `返信先 RC-${marker.root} のスレッドが見つからないため無視しました` });
                roles.set(comment.id, "ignored");
                continue;
            }
            addEvent(key.rootId, { type: "bot_reply", commentId: comment.id, status: marker.status });
            continue;
        }
        if (content.trim() === "") {
            roles.set(comment.id, "ignored");
            continue;
        }
        const ref = parseReference(content);
        if (ref) {
            const rootId = rootOf.get(ref.id);
            if (rootId !== undefined) {
                const role = ref.resolved ? "resolve" : "follow_up";
                roles.set(comment.id, role);
                threads.get(rootId)?.followUpIds.push(comment.id);
                addEvent(rootId, { type: ref.resolved ? "resolve" : "follow_up", commentId: comment.id });
                continue;
            }
            warnings.push({ commentId: comment.id, message: `参照先 RC-${ref.id} が見つからないため、新しい指摘として扱います` });
        }
        roles.set(comment.id, "review");
        rootOf.set(comment.id, comment.id);
        threads.set(comment.id, { rootId: comment.id, root: comment, events: [], followUpIds: [] });
    }
    const result = [];
    for (const thread of threads.values()) {
        let status = "open";
        let lastHumanCommentId = thread.rootId;
        let lastBotReplyId = null;
        for (const event of thread.events) {
            if (event.type === "bot_reply") {
                status = event.status;
                lastBotReplyId = event.commentId;
            }
            else {
                status = event.type === "resolve" ? "resolved" : "open";
                lastHumanCommentId = event.commentId;
            }
        }
        const key = String(thread.rootId);
        const cached = options.interpretations?.get(key);
        if (status === "open" && cached !== undefined && cached.replyStatus === null && cached.lastHumanCommentId === lastHumanCommentId) {
            status = "not_actionable";
        }
        const item = { key, rootId: thread.rootId, status, events: thread.events, lastHumanCommentId, lastBotReplyId };
        const firstReply = thread.events.find((e) => e.type === "bot_reply");
        const firstReplyComment = firstReply && commentById.get(firstReply.commentId);
        const editedAfterReply = firstReplyComment !== undefined && thread.root.updated !== thread.root.created && thread.root.updated > firstReplyComment.created;
        result.push({ rootId: thread.rootId, item, followUpIds: thread.followUpIds, editedAfterReply });
    }
    return { threads: result, roles, summaryCommentId, warnings };
}
