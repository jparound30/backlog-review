/**
 * 対応の記録（§5-2）。指摘 1 件 = 1 行。
 * Backlog のコメントから作り直すので、同じ PR ならどちらのスキルで出しても同じ表になる。
 * 対応側の状態ファイルがあれば、まだ返信していない指摘の分類と not_actionable の判定だけを補う
 */
import type { BacklogComment } from "../backlog/types.ts";
import type { PullRequestRef } from "../backlog/url.ts";
import { parseBodyMarkers } from "../context.ts";
import { type CommentLocation } from "../git/diff.ts";
import type { StoredInterpretation } from "../interpret/interpretation.ts";
import { firstLine, parseReplyBody, parseReplyFields, type ReplyLocation } from "../reply/format.ts";
import { parseFindingMarker, type FindingSeverity } from "../review/finding.ts";
import { type Category, parseCategoryLine } from "../thread/category.ts";
import { hasSummaryMarker, label, type ReplyStatus } from "../thread/marker.ts";
import { buildThreads, type ItemStatus } from "../thread/thread.ts";

export type RecordSource = "human" | "auto_review";

export type ExportRecord = {
  pr: string;
  key: string;
  rootId: number;
  createdAt: string;
  reviewer: string;
  source: RecordSource;
  severity: Exclude<FindingSeverity, "none"> | null;
  category: Category | null;
  /** 分類をどこから読んだか。`interpretation` は対応側の状態ファイルで補ったもの */
  categoryFrom: "root" | "reply" | "interpretation" | null;
  summary: string;
  /** 元のコメントの全文（記録のため省略しない。CSV では改行を ` / ` にする） */
  body: string;
  location: ReplyLocation | null;
  status: ItemStatus;
  /** 最後の自動返信の状態 */
  lastReplyStatus: ReplyStatus | null;
  /** 最後の自動返信の本文の項目（対応内容・回答など） */
  response: string | null;
  commits: string[];
  lastReplyAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  botReplies: number;
  followUps: number;
  /** 自動返信が fixed だったことがある（修正した指摘） */
  everFixed: boolean;
  url: string;
};

export type ExportResult = {
  records: ExportRecord[];
  /** 行にしなかったコメント（サマリー・指摘なし）。注記に出す */
  excluded: Array<{ id: number; reason: "summary" | "no_findings" }>;
  /** not_actionable を出さなかった件数（--all なし） */
  hiddenNotActionable: number;
};

export type ExportInput = {
  pr: PullRequestRef;
  prUrl: string;
  comments: BacklogComment[];
  myselfId: number;
  /** 行コメントの場所（CLI が変換したもの）。root のコメントにだけ使う */
  locate: (comment: BacklogComment) => Promise<CommentLocation | null>;
  /** 対応側の状態ファイルの、今のコメントに対して有効な解釈（レビュー側では空） */
  interpretations: Map<string, StoredInterpretation>;
  /** 対応側の状態ファイルの、指摘ごとの修正コミット（レビュー側では空） */
  stateCommits: Record<string, string[]>;
  all: boolean;
};

/**
 * 自動レビューの指摘なら `指摘:`・`質問:` の行を、なければ最初の行を要約にする。
 * 記録なので、長くても省略しない（§5-2）
 */
function summaryOf(content: string): string {
  const line = parseFindingMarker(content)
    ? content.split("\n").find((l) => l.startsWith("指摘:") || l.startsWith("質問:"))
    : undefined;
  return firstLine(line ? line.replace(/^(?:指摘|質問):\s*/, "") : content, Infinity);
}

function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

export async function buildRecords(input: ExportInput): Promise<ExportResult> {
  // 記録は表示のためだけに使うので、返信マーカーは投稿者を限定せずに読む（§5-2）
  const built = buildThreads(input.comments, {
    myselfId: input.myselfId,
    interpretations: input.interpretations,
    readOthersReplyMarkers: true,
  });
  const byId = new Map(input.comments.map((c) => [c.id, c]));
  const prLabel = `${input.pr.projectKey}/${input.pr.repoName}#${input.pr.number}`;
  const records: ExportRecord[] = [];
  const excluded: ExportResult["excluded"] = [];
  let hiddenNotActionable = 0;

  for (const thread of built.threads) {
    const root = byId.get(thread.rootId)!;
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

    const replies = item.events.flatMap((e) => (e.type === "bot_reply" ? [{ comment: byId.get(e.commentId)!, status: e.status }] : []));
    const last = replies.at(-1);
    const lastFields = last ? parseReplyFields(last.comment.content ?? "") : null;
    const interp = input.interpretations.get(item.key);

    const rootCategory = parseCategoryLine(content);
    const [category, categoryFrom]: [Category | null, ExportRecord["categoryFrom"]] = rootCategory
      ? [rootCategory, "root"]
      : lastFields?.category
        ? [lastFields.category, "reply"]
        : interp?.category
          ? [interp.category, "interpretation"]
          : [null, null];

    const lineComment = await input.locate(root);
    const placed = (interp?.points ?? []).find((p) => p.location.path);
    const location: ReplyLocation | null =
      lineComment && !lineComment.error && lineComment.line !== null
        ? (() => {
            // ファイルが更新されていれば、差分から求めた現在の行番号を使う（返信・サマリーと同じ）
            const line = lineComment.outdated ? lineComment.currentLine : lineComment.line;
            return { path: lineComment.filePath, line, estimated: lineComment.outdated && line === null };
          })()
        : placed
          ? { path: placed.location.path!, line: placed.location.line, estimated: placed.location.judgment !== "explicit" }
          : (lastFields?.location ??
            // 最後に、本文の `場所:` の行（自動レビューの指摘や、レビュアーが書いたもの）
            (() => {
              const marker = parseBodyMarkers(content)[0];
              return marker ? { path: marker.path, line: marker.line, estimated: false } : null;
            })());

    const commits: string[] = [];
    for (const sha of [...replies.flatMap((r) => parseReplyFields(r.comment.content ?? "").commits), ...(input.stateCommits[item.key] ?? [])]) {
      if (/^[0-9a-f]{7,64}$/.test(sha) && !commits.some((c) => sameCommit(c, sha))) commits.push(sha.slice(0, 7));
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
      severity: finding ? (finding.severity as ExportRecord["severity"]) : null,
      category,
      categoryFrom,
      summary: summaryOf(content),
      body: content,
      location,
      status: item.status,
      lastReplyStatus: last?.status ?? null,
      response: last ? parseReplyBody(last.comment.content ?? "") : null,
      commits,
      lastReplyAt: last?.comment.created ?? null,
      resolvedAt: resolveComment?.created ?? null,
      resolvedBy: resolveComment?.createdUser?.name ?? null,
      botReplies: replies.length,
      followUps: item.events.filter((e) => e.type === "follow_up").length,
      everFixed: replies.some((r) => r.status === "fixed"),
      url: `${input.prUrl}#comment-${root.id}`,
    });
  }
  return { records: records.sort((a, b) => a.rootId - b.rootId), excluded, hiddenNotActionable };
}
