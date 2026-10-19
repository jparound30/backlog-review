/**
 * サマリーの更新（plan.md §4-5・§4-5-1）。両方のスキルの CLI から使う。
 * PR の説明文の区画を基本にし、更新できなければ、対応側だけがサマリーコメントを使う。
 * 内容は記録の組み立て（§5-2）から作るので、どちらのスキルで更新しても同じになる
 */
import { createHash } from "node:crypto";
import { BacklogApiError } from "../backlog/client.ts";
import type { PullRequestRef } from "../backlog/url.ts";
import { collectRecords, type ExportContext } from "../export/command.ts";
import { OUTCOME_LABEL } from "../export/format.ts";
import type { ExportRecord } from "../export/record.ts";
import { formatSummary, type SummaryRow } from "../reply/format.ts";
import { hasSummaryMarker, SUMMARY_MARKER_TEXT } from "../thread/marker.ts";
import { applyBlock, formatBlock, locateBlock } from "./description.ts";

export type SummarySide = "fix" | "review";

export type SummaryOptions = {
  post: boolean;
  side: SummarySide;
  /** 下書き（確認②）で表示した内容のダイジェストを残す・読む。`--yes` はこれと同じときだけ反映する */
  saveShown: (digest: string) => Promise<void>;
  loadShown: () => Promise<string | undefined>;
  /** 操作の記録（状態ファイル） */
  log: (action: string, commentId?: number) => Promise<void>;
  now?: Date;
};

/** 以前のサマリーコメントを、説明文へ移したことを伝える文に書き換えるときの本文（§4-5-1） */
export const MOVED_NOTE = `:computer: レビュー対応状況は、PR の説明文に移しました。\n\n${SUMMARY_MARKER_TEXT}`;

function toRows(records: ExportRecord[]): SummaryRow[] {
  return records.map((r) => ({
    key: r.key.replace(/^RC-/, ""),
    reviewerName: r.reviewer,
    // 要約は省略しない（plan.md §4-5-1）。指摘の最初の行の全文
    summary: r.summary,
    status: r.status,
    location: r.location,
    commits: r.commits,
    rootId: r.rootId,
    latestReplyId: r.lastReplyId,
    // 完了した指摘の決着（§7-16）。確認中（needs_info）のまま解決したものは添えない
    outcome: r.status === "resolved" && r.outcome && r.outcome !== "needs_info" ? OUTCOME_LABEL[r.outcome] : null,
  }));
}

/** 説明文の更新を「できない」とみなすエラー（権限がない・長すぎる・文字を拒否された, §4-5-1 の V4・V5） */
function cannotUpdate(error: unknown): string | null {
  if (error instanceof BacklogApiError && error.status >= 400 && error.status < 500) return error.message;
  return null;
}

export async function summaryCommand(pr: PullRequestRef, ctx: ExportContext, options: SummaryOptions): Promise<void> {
  const { result, myself, pullRequest, comments } = await collectRecords(pr, ctx, { all: false, useFixState: options.side === "fix" });
  const rows = toRows(result.records);
  const now = options.now ?? new Date();
  const description = pullRequest.description ?? "";
  // 自分のサマリーコメント（以前の置き場所。説明文を更新できないときの対応側の置き場所）
  const ownSummary = comments.find((c) => c.createdUser?.id === myself.id && hasSummaryMarker(c.content ?? ""));
  const moved = ownSummary !== undefined && (ownSummary.content ?? "").trim() === MOVED_NOTE.trim();

  const block = formatBlock(formatSummary(rows, now, { marker: false }));
  const applied = applyBlock(description, block);
  const broken = locateBlock(description);
  const target: "description" | "comment" | "none" = applied ? "description" : options.side === "fix" ? "comment" : "none";

  // 確認②で見せた置き場所と、--yes で反映する置き場所を結びつける（§4-5-1）。
  // 区画の中身は Backlog の状態から機械的に作るので含めない（確認②の後に返信を投稿すると変わるため）。
  // 説明文は作成者の部分を含めて入れ、下書きの後に編集されていれば --yes を止める。
  // PR の更新日時はコメントの投稿でも変わりうるので使わない
  const digest = createHash("sha256").update(JSON.stringify({ target, description })).digest("hex");

  if (!options.post) {
    if (target === "none") {
      ctx.out(`PR の説明文を更新できません: ${broken.kind === "broken" ? broken.reason : "不明"}`);
      ctx.out("説明文の区画の印（<!-- review-bot summary begin/end -->）を直すか、サマリーは対応側が更新します。サマリーコメントは投稿しません");
      return;
    }
    if (target === "description") {
      ctx.out(`--- PR の説明文の${applied!.action === "append" ? "末尾に、サマリーの区画を足します" : "サマリーの区画を置き換えます"}（区画の外は変えません。--yes を付けると反映します）---`);
      ctx.out(block);
      ctx.out("---");
      ctx.out("区画の中身は、反映するとき（--yes）の Backlog の状態で作り直します。説明文が下書きの後に編集されていれば反映しません");
      if (ownSummary && !moved) ctx.out(`反映できたら、以前のサマリーコメント #${ownSummary.id} を「説明文に移しました」の文に書き換えます`);
      if (options.side === "fix") {
        ctx.out(`説明文を更新できなかったとき（権限がない・API が拒否した）は、同じ内容をサマリーコメント${ownSummary ? ` #${ownSummary.id} に` : "として新規に"}反映します`);
      } else {
        ctx.out("説明文を更新できなかったときは、サマリーコメントは投稿しません（サマリーは対応側が更新します）");
      }
    } else {
      ctx.out(`PR の説明文を更新できないため（${broken.kind === "broken" ? broken.reason : ""}）、サマリーコメント${ownSummary ? ` #${ownSummary.id} を更新` : "を新規に投稿"}します（--yes を付けると反映します）`);
      ctx.out(formatSummary(rows, now));
    }
    await options.saveShown(digest);
    return;
  }

  if (target === "none") throw new Error(`PR の説明文を更新できません: ${broken.kind === "broken" ? broken.reason : "不明"}`);
  if ((await options.loadShown()) !== digest) {
    throw new Error("下書き（--yes なし）を表示していないか、その後に PR の説明文が編集されたか、置き場所が変わりました。下書きからやり直してください");
  }

  if (target === "description") {
    // API に版の確認がないので、直前に取得し直して、作成者の編集を上書きしないか確かめる（§4-5-1）
    const fresh = await ctx.client.getPullRequest(pr);
    if ((fresh.description ?? "") !== description) {
      throw new Error("PR の説明文が、下書きの後に編集されています。上書きしないよう中止しました。下書きからやり直してください");
    }
    let reason: string | null = null;
    try {
      await ctx.client.updatePullRequestDescription(pr, applied!.description, block);
    } catch (error) {
      reason = cannotUpdate(error);
      if (reason === null) throw error;
    }
    if (reason === null) {
      await options.log(applied!.action === "append" ? "summary:description:create" : "summary:description:update");
      ctx.out("PR の説明文のサマリーを更新しました");
      if (ownSummary && !moved) {
        await ctx.client.updateComment(pr, ownSummary.id, MOVED_NOTE);
        await options.log("summary:moved", ownSummary.id);
        ctx.out(`以前のサマリーコメント #${ownSummary.id} を「説明文に移しました」の文に書き換えました`);
      }
      return;
    }
    ctx.out(`PR の説明文を更新できませんでした: ${reason}`);
    if (options.side === "review") {
      ctx.out("サマリーコメントは投稿しません（サマリーは対応側が更新します）");
      return;
    }
    ctx.out("同じ内容をサマリーコメントに反映します");
  }

  // 対応側だけ: 今までどおりのサマリーコメント（§4-5）
  const text = formatSummary(rows, now);
  const posted = ownSummary ? await ctx.client.updateComment(pr, ownSummary.id, text) : await ctx.client.postComment(pr, text);
  await options.log(ownSummary ? "summary:update" : "summary:create", posted.id);
  ctx.out(`サマリーコメントを${ownSummary ? "更新" : "投稿"}しました: #${posted.id}`);
}
