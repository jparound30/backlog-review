/** §4 のコメントルールで使う書式の解析と生成 */

/** Bot の返信が持つ状態（not_actionable には返信しないので含まない） */
export const REPLY_STATUSES = ["fixed", "answered", "needs_info", "wontfix"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export function isReplyStatus(value: unknown): value is ReplyStatus {
  return typeof value === "string" && (REPLY_STATUSES as readonly string[]).includes(value);
}

/** 対応の単位。指摘のコメント ID（1 コメント = 1 指摘。分割はしない, §7-8） */
export type ItemKey = string;
const ITEM_KEY = /^(\d+)$/;

export function parseItemKey(key: string): { rootId: number } | null {
  const m = ITEM_KEY.exec(key);
  return m ? { rootId: Number(m[1]) } : null;
}

export const label = (key: ItemKey) => `RC-${key}`;

export type ReplyMarker = { root: ItemKey; replyTo: number; status: ReplyStatus };

// マーカーは本文の最後の行（空行を除く）にあるものだけを有効にする。
// 本文の途中に他人の文を引用しても、マーカーと誤認されないようにするため。
// 以前は指摘を分割して `root=12345#1` と書いていた。`#数字` は無視して root 全体への返信として読む（§4-1）
const REPLY_MARKER = /^`\[review-bot root=(\d+)(?:#\d+)? reply-to=(\d+) status=([a-z_]+)\]`$/;
const SUMMARY_MARKER = /^`\[review-bot summary\]`$/;

/** 本文の最後の行（空行を除く）。マーカーはここにあるものだけ有効 */
export function lastLine(content: string): string {
  const lines = content.split("\n").map((line) => line.trim());
  return lines.findLast((line) => line !== "") ?? "";
}

export function formatReplyMarker(marker: ReplyMarker): string {
  return `\`[review-bot root=${marker.root} reply-to=${marker.replyTo} status=${marker.status}]\``;
}

export const SUMMARY_MARKER_TEXT = "`[review-bot summary]`";

/** 返信のマーカー（最後の行）を読む。状態が不正なら null */
export function parseReplyMarker(content: string): ReplyMarker | null {
  const m = REPLY_MARKER.exec(lastLine(content));
  if (!m || !isReplyStatus(m[3])) return null;
  return { root: m[1], replyTo: Number(m[2]), status: m[3] };
}

export function hasSummaryMarker(content: string): boolean {
  return SUMMARY_MARKER.test(lastLine(content));
}

/**
 * 他人の文やコメント由来の文を Bot のコメントに載せる前に無害化する（§6）。
 * - マーカーに見える文字列を崩す（Bot のコメントの誤認を防ぐ）
 * - `@` を全角にする（自分のアカウントからの意図しないメンション通知を防ぐ）
 */
export function neutralize(text: string): string {
  return text.replace(/\[review-bot/g, "［review-bot").replace(/@/g, "＠");
}

/**
 * 他人の文を引用するときに、Markdown のリンク・画像・HTML として働かないようにする（§6-1）。
 * 自分のアカウントのコメントとして、外部へのリンクや追跡用の画像が表示されるのを防ぐ
 */
export function escapeMarkdown(text: string): string {
  return neutralize(text).replace(/[\\[\]()!<>*_`]/g, (ch) => `\\${ch}`);
}

// 裸の URL。末尾の句読点や閉じ括弧は URL に含めない
const BARE_URL = /\b(?:(?:https?|ftp):\/\/|www\.)[^\s<>`"'|]+?(?=[.,;:!?)\]}、。」』）]*(?:[\s<>`"'|]|$))/gi;

/**
 * 他人の文を引用するときの無害化（公開前チェック S-3）。
 * Markdown の記法をエスケープしたうえで、裸の URL をインラインコードで囲み、リンクにならないようにする。
 * URL の文字は変えないので、読んだりコピーしたりはできる
 */
export function escapeQuoted(text: string): string {
  let result = "";
  let last = 0;
  for (const m of text.matchAll(BARE_URL)) {
    result += escapeMarkdown(text.slice(last, m.index));
    result += `\`${neutralize(m[0])}\``;
    last = m.index + m[0].length;
  }
  return result + escapeMarkdown(text.slice(last));
}

export type Reference = { id: number; resolved: boolean };

/**
 * 日本語入力で書かれた番号を読めるようにそろえる（R-6）。
 * NFKC で全角の英数字と記号を半角にし（`ＲＣ－１２３` → `RC-123`）、
 * ハイフンに似た文字（`‐` `‑` `‒` `–` `—` `―` `−` と、長音の `ー`）を `-` にする。
 * Node.js の標準機能だけで行う
 */
function normalizeReference(line: string): string {
  return line.normalize("NFKC").replace(/[\u2010-\u2015\u2212\u30fc]/g, "-");
}

/**
 * 番号の直後にある解決の印（§4-2）。✅ のほか、似た記号と、絵文字の記法も受け付ける（R-6）。
 * 「済」などの言葉は「済みではない」と区別できないので印にしない
 */
const RESOLVED_MARK =
  /^\s*[:：]?\s*(?:✅|✔|☑|✓|:(?:white_check_mark|heavy_check_mark|ballot_box_with_check):)/u;

/**
 * レビュアーのコメントの先頭にある `RC-123` と、解決の印 `✅` を読む（§4-2）。
 * 先頭（最初の空でない行の行頭）にあるものだけを参照として扱う。
 * 以前の分割の書き方（`RC-123#1`）の `#数字` は無視して、指摘全体への参照として読む（§4-1）
 */
export function parseReference(content: string): Reference | null {
  const firstLine = content.split("\n").find((line) => line.trim() !== "") ?? "";
  const m = /^\s*RC-(\d+)(?:#\d+)?(.*)$/i.exec(normalizeReference(firstLine));
  if (!m) return null;
  return { id: Number(m[1]), resolved: RESOLVED_MARK.test(m[2]) };
}

/**
 * 解決のコメントが取り下げ（`RC-123 ✅ 対応不要`。`修正不要` も, §4-2）かどうか。
 * 表示と記録の「どう決着したか」にだけ使い、状態は変えない（§7-16）
 */
export function isWithdrawal(content: string): boolean {
  const firstLine = content.split("\n").find((line) => line.trim() !== "") ?? "";
  const m = /^\s*RC-\d+(?:#\d+)?(.*)$/i.exec(normalizeReference(firstLine));
  if (!m) return false;
  const mark = RESOLVED_MARK.exec(m[1]);
  return mark !== null && /^[\s\uFE0F]*(?:対応|修正)不要/.test(m[1].slice(mark[0].length));
}
