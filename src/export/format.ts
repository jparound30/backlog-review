/**
 * 対応の記録の書き出し（§5-2）。CSV（Excel で開ける形）と、集計つきの Markdown。
 * コメントの本文は信頼できない入力なので、数式の注入・制御文字・秘密情報を処理してから書く
 */
import { containsApiKey, findSecretPattern } from "../backlog/secrets.ts";
import { cell } from "../reply/format.ts";
import { escapeQuoted } from "../thread/marker.ts";
import { CATEGORIES, categoryLabel } from "../thread/category.ts";
import type { ReplyStatus } from "../thread/marker.ts";
import type { ItemStatus } from "../thread/thread.ts";
import { sanitizeForTerminal } from "../text.ts";
import type { ExportRecord, ExportResult, HistoryItem } from "./record.ts";

const RESPONSE_LABEL: Record<ReplyStatus, string> = {
  fixed: "修正",
  answered: "回答",
  needs_info: "確認中",
  wontfix: "見送り",
};

const STATUSES: ItemStatus[] = ["open", "needs_info", "fixed", "answered", "wontfix", "resolved", "not_actionable"];

export const SECRET_OMITTED = "（秘密情報らしき文字列のため省略）";

/** 利用者の環境のタイムゾーンで `YYYY-MM-DD HH:mm`。テストのため時差（分）を渡せる */
export function formatTime(iso: string | null, offsetMinutes?: number): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offset = offsetMinutes ?? -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ${p(local.getUTCHours())}:${p(local.getUTCMinutes())}`;
}

export function formatRecordLocation(r: ExportRecord): string {
  if (!r.location) return "";
  return `${r.location.path}${r.location.line === null ? "" : ` L${r.location.line}`}${r.location.estimated ? "（推定）" : ""}`;
}

/**
 * 表示を偽装できる文字を除く。記録なので改行は残し、LF にそろえる（行の区切りの CRLF と見分けるため, §5-2）。
 * 秘密情報らしき文字列があればセルごと省く
 */
function clean(text: string, apiKey: string | undefined): string {
  const value = sanitizeForTerminal(text.replace(/\r\n?/g, "\n")).trim();
  if (findSecretPattern(value) || (apiKey && containsApiKey(value, apiKey))) return SECRET_OMITTED;
  return value;
}

const HISTORY_KIND: Record<HistoryItem["kind"], string> = {
  review: "指摘",
  follow_up: "追加の指示・回答",
  resolve: "解決",
  bot_reply: "自動返信",
};

/**
 * 「やり取り」の列（§5-2）。1 件ごとに `【番号】日時 投稿者（種類）: 本文`。
 * 秘密情報らしき文字列は、そのコメントの本文だけを省く（列全体は省かない）
 */
/** ファイル内のリンクの ID（§5-2）。コメント ID（数字）だけから作る */
const listAnchor = (r: ExportRecord) => `rc-${r.rootId}`;
const historyAnchor = (r: ExportRecord) => `history-rc-${r.rootId}`;

function historyKind(h: HistoryItem): string {
  return h.kind === "bot_reply" && h.status ? `${HISTORY_KIND[h.kind]}・${h.status}` : HISTORY_KIND[h.kind];
}

/**
 * Markdown の「やり取り」の節（§5-2）。指摘ごとに見出しを立て、コメントを時系列の番号付きの一覧にする。
 * 本文は改行を残した引用にし、行ごとにエスケープする（リンクや画像として働かないように）
 */
export function formatHistoryMarkdown(records: ExportRecord[], options: { apiKey?: string; offsetMinutes?: number } = {}): string[] {
  const lines: string[] = ["", "## やり取り"];
  for (const r of records) {
    lines.push(
      "",
      `### <a id="${historyAnchor(r)}"></a>${r.key}: ${cell(clean(r.summary, options.apiKey), Infinity)}`,
      "",
      `[一覧に戻る](#${listAnchor(r)})`,
      "",
    );
    r.history.forEach((h, i) => {
      lines.push(`${i + 1}. ${formatTime(h.at, options.offsetMinutes)} ${cell(clean(h.author, options.apiKey), Infinity)}（${historyKind(h)}）`);
      const body = clean(h.body, options.apiKey);
      for (const line of body.split("\n")) lines.push(line.trim() === "" ? "   >" : `   > ${escapeQuoted(line)}`);
    });
  }
  return lines;
}

export function formatHistory(history: HistoryItem[], options: { apiKey?: string; offsetMinutes?: number } = {}): string {
  return history
    .map((h, i) => {
      return `【${i + 1}】${formatTime(h.at, options.offsetMinutes)} ${clean(h.author, options.apiKey)}（${historyKind(h)}）: ${clean(h.body, options.apiKey)}`;
    })
    .join("\n");
}

/** CSV のセル。改行は引用符の中に残る。`=`・`+`・`-`・`@` などで始まる値は、表計算ソフトで数式として働かないよう先頭に `'` を付ける */
export function csvCell(text: string, apiKey?: string): string {
  let value = clean(text, apiKey);
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  return `"${value.replace(/"/g, '""')}"`;
}

const COLUMNS: Array<[string, (r: ExportRecord, offset?: number, apiKey?: string) => string]> = [
  ["PR", (r) => r.pr],
  ["RC", (r) => r.key],
  ["指摘日時", (r, o) => formatTime(r.createdAt, o)],
  ["指摘者", (r) => r.reviewer],
  ["出どころ", (r) => (r.source === "auto_review" ? "自動レビュー" : "人間")],
  ["重大度", (r) => r.severity ?? ""],
  ["分類", (r) => (r.category ? categoryLabel(r.category) : "")],
  ["要約", (r) => r.summary],
  ["本文", (r) => r.body],
  ["場所", (r) => formatRecordLocation(r)],
  ["状態", (r) => r.status],
  ["対応区分", (r) => (r.lastReplyStatus ? RESPONSE_LABEL[r.lastReplyStatus] : "")],
  ["対応内容", (r) => r.response ?? ""],
  ["やり取り", (r, o, k) => formatHistory(r.history, { apiKey: k, offsetMinutes: o })],
  ["コミット", (r) => r.commits.join(", ")],
  ["最終返信日時", (r, o) => formatTime(r.lastReplyAt, o)],
  ["解決日時", (r, o) => formatTime(r.resolvedAt, o)],
  ["解決者", (r) => r.resolvedBy ?? ""],
  ["自動返信の回数", (r) => String(r.botReplies)],
  ["追加コメントの回数", (r) => String(r.followUps)],
  ["リンク", (r) => r.url],
];

/** UTF-8（BOM 付き）・CRLF・すべてのセルを引用符で囲む。Excel でそのまま開ける */
export function formatCsv(records: ExportRecord[], options: { apiKey?: string; offsetMinutes?: number } = {}): string {
  const lines = [COLUMNS.map(([name]) => csvCell(name)).join(",")];
  for (const r of records) lines.push(COLUMNS.map(([, get]) => csvCell(get(r, options.offsetMinutes, options.apiKey), options.apiKey)).join(","));
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

function days(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

export type MarkdownMeta = {
  prUrl: string;
  title: string;
  generatedAt: string;
  /** 出力したスキル */
  skill: string;
  /** 状態ファイルを使わなかった理由など */
  notes: string[];
  apiKey?: string;
  offsetMinutes?: number;
};

/** 集計つきの Markdown。表のセルは、リンクや画像として働かないようエスケープする */
export function formatMarkdown(result: ExportResult, meta: MarkdownMeta): string {
  const { records } = result;
  // 記録なので、表のセルも長さで省略しない（§5-2）
  const md = (text: string) => cell(clean(text, meta.apiKey), Infinity);
  const counted = records.filter((r) => r.status !== "not_actionable");
  const resolved = counted.filter((r) => r.status === "resolved");
  const lines: string[] = [
    `# レビュー対応の記録: ${md(records[0]?.pr ?? meta.prUrl)}`,
    "",
    `- PR: ${md(meta.title)}（\`${meta.prUrl.replace(/`/g, "")}\`）`,
    `- 出力日時: ${formatTime(meta.generatedAt, meta.offsetMinutes)}（${meta.skill} の export）`,
    "",
    "## 集計",
    "",
    `- 指摘: ${counted.length} 件（not_actionable を除く）`,
    `- 完了（resolved）: ${resolved.length} 件${counted.length > 0 ? `（${Math.round((resolved.length / counted.length) * 100)}%）` : ""}`,
    `- 修正した指摘（自動返信が fixed だったことのあるもの）: ${counted.filter((r) => r.everFixed).length} 件`,
  ];
  const durations = resolved.filter((r) => r.resolvedAt).map((r) => days(r.createdAt, r.resolvedAt!));
  lines.push(
    durations.length > 0
      ? `- 解決までの日数: 中央値 ${oneDecimal(median(durations))} 日・最大 ${oneDecimal(Math.max(...durations))} 日（解決した ${durations.length} 件）`
      : "- 解決までの日数: 解決した指摘なし",
  );

  const count = (pick: (r: ExportRecord) => string, keys: string[]) =>
    keys.map((k) => [k, counted.filter((r) => pick(r) === k).length] as const).filter(([, n]) => n > 0);
  const table = (title: string, rows: ReadonlyArray<readonly [string, number]>) => {
    if (rows.length === 0) return;
    lines.push("", `### ${title}`, "", "| 区分 | 件数 |", "|---|---|", ...rows.map(([k, n]) => `| ${k} | ${n} |`));
  };
  table("状態別", count((r) => r.status, STATUSES));
  table("出どころ別", count((r) => (r.source === "auto_review" ? "自動レビュー" : "人間"), ["人間", "自動レビュー"]));
  table("重大度別（自動レビューの指摘）", count((r) => r.severity ?? "", ["critical", "warning", "suggestion"]));

  // 分類×状態
  const categoryName = (r: ExportRecord) => (r.category ? categoryLabel(r.category) : "分類なし");
  const categories = [...CATEGORIES.map((c) => c.label), "分類なし"].filter((name) => counted.some((r) => categoryName(r) === name));
  const statuses = STATUSES.filter((s) => counted.some((r) => r.status === s));
  if (categories.length > 0) {
    lines.push("", "### 分類別", "", `| 分類 | 計 | ${statuses.join(" | ")} |`, `|---|---|${statuses.map(() => "---|").join("")}`);
    for (const name of categories) {
      const of = counted.filter((r) => categoryName(r) === name);
      lines.push(`| ${name} | ${of.length} | ${statuses.map((s) => of.filter((r) => r.status === s).length).join(" | ")} |`);
    }
  }

  const notes = [...meta.notes];
  const supplemented = records.filter((r) => r.categoryFrom === "interpretation").map((r) => r.key);
  if (supplemented.length > 0) notes.push(`分類を、対応側の状態ファイルの解釈で補った指摘: ${supplemented.join(", ")}`);
  const uncategorized = records.filter((r) => r.category === null && r.status !== "not_actionable").map((r) => r.key);
  if (uncategorized.length > 0) notes.push(`分類なしの指摘: ${uncategorized.join(", ")}（本文に \`分類:\` がなく、自動返信も解釈もないもの）`);
  const excluded = (reason: string) => result.excluded.filter((e) => e.reason === reason).map((e) => `#${e.id}`);
  if (excluded("summary").length > 0) notes.push(`行にしなかったサマリーコメント: ${excluded("summary").join(", ")}`);
  if (excluded("no_findings").length > 0) notes.push(`行にしなかった「指摘なし」のコメント: ${excluded("no_findings").join(", ")}`);
  if (result.hiddenNotActionable > 0) notes.push(`返信しない指摘（not_actionable）${result.hiddenNotActionable} 件は出していません（--all で出す）`);
  if (notes.length > 0) lines.push("", "## 注記", "", ...notes.map((n) => `- ${n}`));

  lines.push(
    "",
    "## 一覧",
    "",
    "| RC | 指摘日時 | 指摘者 | 分類 | 重大度 | 要約 | 場所 | 状態 | 対応区分 | コミット | 解決日時 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of records) {
    lines.push(
      `| ${[
        // 一覧の行の ID と、その指摘のやり取りへのリンク
        `<a id="${listAnchor(r)}"></a>[${r.key}](#${historyAnchor(r)})`,
        formatTime(r.createdAt, meta.offsetMinutes),
        md(r.reviewer),
        r.category ? categoryLabel(r.category) : "",
        r.severity ?? "",
        md(r.summary),
        md(formatRecordLocation(r)),
        r.status,
        r.lastReplyStatus ? RESPONSE_LABEL[r.lastReplyStatus] : "",
        r.commits.join(", "),
        formatTime(r.resolvedAt, meta.offsetMinutes),
      ].join(" | ")} |`,
    );
  }
  lines.push(...formatHistoryMarkdown(records, { apiKey: meta.apiKey, offsetMinutes: meta.offsetMinutes }));
  return `${lines.join("\n")}\n`;
}
