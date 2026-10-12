import type { BacklogComment } from "../backlog/types.ts";
import {
  hasSummaryMarker,
  type ItemKey,
  parseItemKey,
  parseReference,
  parseReplyMarker,
  type ReplyStatus,
} from "./marker.ts";

/** §4-4 の状態 */
export type ItemStatus = "open" | ReplyStatus | "not_actionable" | "resolved";

export type CommentRole = "review" | "follow_up" | "resolve" | "bot_reply" | "summary" | "ignored";

export type ThreadEvent =
  | { type: "bot_reply"; commentId: number; status: ReplyStatus }
  | { type: "follow_up"; commentId: number }
  | { type: "resolve"; commentId: number };

export type Item = {
  key: ItemKey;
  rootId: number;
  status: ItemStatus;
  events: ThreadEvent[];
  /** この指摘に関わる人間のコメントのうち最新のもの（解釈の有効期限の判定に使う, §5-1） */
  lastHumanCommentId: number;
  lastBotReplyId: number | null;
};

/** 1 コメント = 1 指摘。コメントに複数の論点があっても分割しない（§7-8） */
export type Thread = {
  rootId: number;
  item: Item;
  /** root 以降の人間のコメント（追加の指示・再指摘・解決） */
  followUpIds: number[];
  /** Bot が返信した後に root が編集されている（自動では open に戻さない） */
  editedAfterReply: boolean;
};

export type ThreadWarning = { commentId: number; message: string };

export type BuildResult = {
  threads: Thread[];
  roles: Map<number, CommentRole>;
  summaryCommentId: number | null;
  warnings: ThreadWarning[];
};

export type BuildOptions = {
  myselfId: number;
  /** ローカルに保存した解釈（返信しない not_actionable の判定に使う。replyStatus が null なら返信しない） */
  interpretations?: Map<ItemKey, { replyStatus: ReplyStatus | null; lastHumanCommentId: number }>;
};

/**
 * コメント一覧からスレッドを組み立て、指摘ごとの状態を求める（§4, §4-6）。
 * Backlog のコメントだけから決まるので、ローカルの状態が消えても同じ結果になる。
 */
export function buildThreads(comments: BacklogComment[], options: BuildOptions): BuildResult {
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const roles = new Map<number, CommentRole>();
  const warnings: ThreadWarning[] = [];
  const rootOf = new Map<number, number>();
  const threads = new Map<number, { rootId: number; root: BacklogComment; events: ThreadEvent[]; followUpIds: number[] }>();
  let summaryCommentId: number | null = null;

  const addEvent = (rootId: number, event: ThreadEvent) => {
    const thread = threads.get(rootId);
    if (!thread) return;
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
    const marker = isMine ? parseReplyMarker(content) : null;
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

  const result: Thread[] = [];
  for (const thread of threads.values()) {
    let status: ItemStatus = "open";
    let lastHumanCommentId = thread.rootId;
    let lastBotReplyId: number | null = null;
    for (const event of thread.events) {
      if (event.type === "bot_reply") {
        status = event.status;
        lastBotReplyId = event.commentId;
      } else {
        status = event.type === "resolve" ? "resolved" : "open";
        lastHumanCommentId = event.commentId;
      }
    }
    const key = String(thread.rootId);
    const cached = options.interpretations?.get(key);
    if (status === "open" && cached !== undefined && cached.replyStatus === null && cached.lastHumanCommentId === lastHumanCommentId) {
      status = "not_actionable";
    }
    const item: Item = { key, rootId: thread.rootId, status, events: thread.events, lastHumanCommentId, lastBotReplyId };

    const firstReply = thread.events.find((e) => e.type === "bot_reply");
    const firstReplyComment = firstReply && sorted.find((c) => c.id === firstReply.commentId);
    const editedAfterReply =
      firstReplyComment !== undefined && thread.root.updated !== thread.root.created && thread.root.updated > firstReplyComment.created;

    result.push({ rootId: thread.rootId, item, followUpIds: thread.followUpIds, editedAfterReply });
  }

  return { threads: result, roles, summaryCommentId, warnings };
}
