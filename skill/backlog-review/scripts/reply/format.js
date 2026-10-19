import { isRepoRelativePath, isUnsafePath, replaceFourByteChars } from "../text.js";
import { formatReplyCategoryLine, parseReplyCategoryLine } from "../thread/category.js";
import { escapeQuoted, formatReplyMarker, parseReplyMarker, label, neutralize, SUMMARY_MARKER_TEXT } from "../thread/marker.js";
const STATUS_LABEL = {
    fixed: "✅ 対応済み",
    answered: ":speech_balloon: 回答",
    needs_info: "❓ 確認させてください",
    wontfix: ":no_good: 対応を見送ります",
};
/** 状態ごとに本文の見出しを変える */
const BODY_HEADING = {
    fixed: "対応内容",
    answered: "回答",
    needs_info: "確認したいこと",
    wontfix: "見送る理由",
};
const SUMMARY_STATUS_LABEL = {
    open: "⏳ open",
    fixed: "✅ fixed",
    answered: ":speech_balloon: answered",
    needs_info: "❓ needs_info",
    wontfix: ":no_good: wontfix",
    not_actionable: "－",
    resolved: "☑️ resolved",
};
/** 先頭行（エスケープなし）。参照の `RC-123` は取り除く。端末への表示や要約に使う */
export function firstLine(content, max = 60) {
    const line = (content.split("\n").find((l) => l.trim() !== "") ?? "").replace(/^\s*RC-\d+(?:#\d+)?\s*/, "").trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
}
/** Bot のコメントに引用する先頭行（Markdown として働かないようにエスケープ済み） */
export function quoteLine(content, max = 60) {
    return escapeQuoted(firstLine(content, max));
}
/** マークダウンの表を壊さないよう、セルの中身を 1 行にして `|` を逃がす */
export function cell(text, max = 60) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    const short = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
    return escapeQuoted(short).replace(/\|/g, "\\|");
}
export function formatLocation(location) {
    if (!location)
        return "不明";
    const line = location.line === null ? "" : ` L${location.line}`;
    const more = location.more ? `（ほか ${location.more} 箇所）` : "";
    return `\`${neutralize(location.path).replace(/`/g, "")}\`${line}${location.estimated ? "（推定）" : ""}${more}`;
}
/** Bot の返信（§4-3） */
export function formatReply(input) {
    const lines = [
        `:computer: 自動対応 ↩️ ${label(input.key)} への返信（${escapeQuoted(input.reviewerName)} さん）`,
        `> ${quoteLine(input.quoteSource) || "（本文なし）"}`,
        "",
        `**状態**: ${STATUS_LABEL[input.status]}`,
        `**場所**: ${formatLocation(input.location)}`,
        ...(input.category ? [formatReplyCategoryLine(input.category)] : []),
        `**${BODY_HEADING[input.status]}**: ${neutralize(input.body.trim())}`,
    ];
    if (input.rankReasons && input.rankReasons.length > 0) {
        lines.push(`**自動で修正しなかった理由**: ${input.rankReasons.join("、")}`);
    }
    if (input.commits.length > 0) {
        lines.push(`**コミット**: ${input.commits.map((sha) => sha.slice(0, 7)).join(", ")}`);
    }
    lines.push("", formatReplyMarker({ root: input.key, replyTo: input.replyTo, status: input.status }));
    // 4 バイト文字は投稿の直前にも置き換わる（§4-7）。下書きで見せる本文を、投稿する本文とそろえる
    return replaceFourByteChars(lines.join("\n"));
}
/**
 * 自分の自動返信から、CLI が書いた「場所」と「コミット」を読み戻す（§5-1 の 6, R-14）。
 * 本文（エージェントが書く）に同じ形の行があっても取り違えないよう、決まった位置の行だけを読む:
 * 場所は「**状態**:」の次の行、分類はその次の行（§4-8。以前の版の返信にはない）、コミットはマーカーの直前の行。
 * コミットは fixed の返信にだけ付き、fixed には必ず付く（§3-1）。fixed 以外ではマーカーの直前が本文になりうるので読まない
 */
export function parseReplyFields(content) {
    const lines = content.split("\n").map((l) => l.trim());
    const status = lines.findIndex((l) => l.startsWith("**状態**:"));
    const loc = status >= 0 ? /^\*\*場所\*\*: `([^`]+)`(?: L(\d+))?(（推定）)?(?:（ほか (\d+) 箇所）)?$/.exec(lines[status + 1] ?? "") : null;
    const location = loc && !isUnsafePath(loc[1]) && isRepoRelativePath(loc[1])
        ? { path: loc[1], line: loc[2] ? Number(loc[2]) : null, estimated: loc[3] !== undefined, more: loc[4] ? Number(loc[4]) : 0 }
        : null;
    const filled = lines.filter((l) => l !== "");
    const fixed = parseReplyMarker(content)?.status === "fixed";
    const commitLine = fixed ? /^\*\*コミット\*\*: ([0-9a-f]{7,64}(?:, [0-9a-f]{7,64})*)$/.exec(filled.at(-2) ?? "") : null;
    // 場所の行がある返信だけ読む（CLI が書いた形の返信に限る）
    const category = status >= 0 && lines[status + 1]?.startsWith("**場所**:") ? parseReplyCategoryLine(lines[status + 2] ?? "") : null;
    return { location, commits: commitLine ? commitLine[1].split(", ") : [], category };
}
/**
 * 自分の自動返信から、本文の項目（`**対応内容**:`・`**回答**:` など）を読み戻す（§5-2）。
 * 見出しの行から、CLI が本文の後に書く行（自動で修正しなかった理由・コミット・マーカー）の前まで。
 * CLI が書く行は下から順に取り除くので、本文に同じ形の行があっても、本文の終わりを取り違えない
 */
export function parseReplyBody(content) {
    const status = parseReplyMarker(content)?.status;
    if (!status)
        return null;
    const lines = content.split("\n");
    const prefix = `**${BODY_HEADING[status]}**: `;
    const start = lines.findIndex((l) => l.startsWith(prefix));
    if (start < 0)
        return null;
    let end = lines.length;
    while (end > start + 1 && lines[end - 1].trim() === "")
        end--;
    end--; // マーカーの行
    while (end > start + 1 && lines[end - 1].trim() === "")
        end--;
    if (status === "fixed" && end > start + 1 && /^\*\*コミット\*\*: /.test(lines[end - 1]))
        end--;
    if (end > start + 1 && lines[end - 1].startsWith("**自動で修正しなかった理由**: "))
        end--;
    const body = [lines[start].slice(prefix.length), ...lines.slice(start + 1, end)].join("\n").trim();
    return body === "" ? null : body;
}
/**
 * 同じ PR の画面の中のコメントへのリンク（`#comment-{ID}`）。
 * サマリーは同じ画面にあるのでページ内で移動でき、新しいタブも開かない。
 * ID が正の整数でなければ、リンクにせず文字だけを返す（§4-5）
 */
export function commentLink(text, commentId) {
    if (!Number.isSafeInteger(commentId) || commentId <= 0)
        return text;
    return `[${text}](#comment-${commentId})`;
}
/** 東京時間の "YYYY-MM-DD HH:mm" */
function formatJst(date) {
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 16).replace("T", " ");
}
/** レビュアーが次にすること（§4-5）。表の「状態」列の値ごとに書く */
export const NEXT_STEPS = [
    "**:memo: 次にすること**（すべての指摘が ☑️ resolved になれば完了です。番号は上の表の RC 列。コメントの**先頭**に書く）",
    "- ⏳ open → 自動対応を待つ（レビュアーは何もしなくてよい）",
    "- ✅ fixed → 確認して問題なければ `RC-番号 ✅`、直っていなければ `RC-番号 理由`",
    "- ❓ needs_info → `RC-番号 回答` で答える",
    "- :speech_balloon: answered / :no_good: wontfix → 納得なら `RC-番号 ✅`、そうでなければ `RC-番号 理由`",
    "- ☑️ resolved → 完了（何もしなくてよい。括弧の中はどう決着したか）",
    "- 対応不要にする → `RC-番号 ✅ 対応不要`",
    "- 新しく指摘する → 行コメントで付ける（または `場所: ファイル L行`）。1 コメントに 1 指摘",
];
/** 進み具合の 1 行（§4-5）。not_actionable を除いて数える */
export function formatProgress(statuses) {
    const counted = statuses.filter((s) => s !== "not_actionable");
    const done = counted.filter((s) => s === "resolved").length;
    const waitingReviewer = counted.filter((s) => s === "fixed" || s === "answered" || s === "wontfix" || s === "needs_info").length;
    const waitingBot = counted.filter((s) => s === "open").length;
    return `進み具合: ☑️ 完了 ${done} / ${counted.length} 件（レビュアーの確認待ち ${waitingReviewer} 件・自動対応待ち ${waitingBot} 件）`;
}
/**
 * サマリー（§4-5）。not_actionable は出さない。要約の列は省略しない（§4-5-1。エスケープはほかのセルと同じ）。
 * PR の説明文の区画に置くとき（§4-5-1）は `marker: false` にする。説明文ではマーカーを読まないため
 */
export function formatSummary(rows, now = new Date(), options = {}) {
    const visible = rows.filter((r) => r.status !== "not_actionable");
    const lines = [`## :computer: レビュー対応状況（最終更新: ${formatJst(now)}）`, ""];
    if (visible.length === 0) {
        lines.push("対応が必要な指摘はありません。");
    }
    else {
        lines.push(formatProgress(visible.map((r) => r.status)), "");
        lines.push("| RC | 指摘者 | 要約 | 状態 | 場所 | コミット | 最新の返信 |", "|----|--------|------|------|------|----------|------------|");
        for (const r of visible) {
            const shas = r.commits.filter((sha) => /^[0-9a-f]{7,64}$/.test(sha));
            const commits = shas.length > 0 ? shas.map((sha) => sha.slice(0, 7)).join(", ") : "-";
            const rc = commentLink(label(r.key), r.rootId);
            const latest = r.latestReplyId ? commentLink(`#${r.latestReplyId}`, r.latestReplyId) : "-";
            const status = SUMMARY_STATUS_LABEL[r.status] + (r.status === "resolved" && r.outcome ? `（${cell(r.outcome)}）` : "");
            lines.push(`| ${rc} | ${cell(r.reviewerName)} | ${cell(r.summary, Infinity)} | ${status} | ${formatLocation(r.location).replace(/\|/g, "\\|")} | ${commits} | ${latest} |`);
        }
    }
    // マーカーは最後の行でないと働かないので、「次にすること」はその前に置く（§6-1）
    lines.push("", ...NEXT_STEPS);
    if (options.marker ?? true)
        lines.push("", SUMMARY_MARKER_TEXT);
    return replaceFourByteChars(lines.join("\n"));
}
