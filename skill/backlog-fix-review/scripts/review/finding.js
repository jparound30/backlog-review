/**
 * レビューする側の指摘（finding）の書式（plan-review.md §2-1）。
 * 対応側の `parseReplyMarker` / `hasSummaryMarker` に一致しない形にし、対応側では通常の指摘として読まれる
 */
import { createHash } from "node:crypto";
import { isRepoRelativePath, isUnsafePath } from "../text.js";
import { lastLine, neutralize } from "../thread/marker.js";
/** 重大度。`none` は「指摘なし」のコメント（§2-3） */
export const FINDING_SEVERITIES = ["critical", "warning", "suggestion", "none"];
export function isFindingSeverity(value) {
    return typeof value === "string" && FINDING_SEVERITIES.includes(value);
}
export const SEVERITY_MARK = {
    critical: "🔴 critical",
    warning: "🟠 warning",
    suggestion: "🔵 suggestion",
    none: "指摘なし",
};
const FINDING_MARKER = /^`\[review-bot finding severity=([a-z]+)\]`$/;
export function formatFindingMarker(marker) {
    return `\`[review-bot finding severity=${marker.severity}]\``;
}
/** 最後の行にある finding のマーカーを読む。重大度が不正なら null */
export function parseFindingMarker(content) {
    const m = FINDING_MARKER.exec(lastLine(content));
    if (!m || !isFindingSeverity(m[1]))
        return null;
    return { severity: m[1] };
}
/** 人間向けの 1 行目（§2-1） */
export const FINDING_HEADLINE = "🤖 自動レビュー";
const MAX_TEXT = 2000;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u2028\u2029\ufeff]/g;
/** `CONTROL` は g フラグ付きなので、test() の lastIndex に左右されないよう毎回リセットして使う */
export function hasControl(value) {
    CONTROL.lastIndex = 0;
    return CONTROL.test(value);
}
function text(value, at, errors, required) {
    if (value === undefined || value === null) {
        if (required)
            errors.push(`${at} がありません`);
        return null;
    }
    if (typeof value !== "string") {
        errors.push(`${at} は文字列にしてください`);
        return null;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        if (required)
            errors.push(`${at} が空です`);
        return null;
    }
    if (trimmed.length > MAX_TEXT)
        errors.push(`${at} が長すぎます（${trimmed.length} 文字。上限 ${MAX_TEXT}）`);
    // 1 文の項目。改行を許すと、投稿本文に `📍` や `期待:` の行を足せてしまう
    if (/[\r\n]/.test(trimmed))
        errors.push(`${at} に改行を含めないでください（1 文で書く）`);
    if (hasControl(trimmed))
        errors.push(`${at} に制御文字や見えない文字が含まれています`);
    return trimmed;
}
/** エージェントの指摘の JSON（配列）を検証する */
export function validateFindings(data) {
    const errors = [];
    if (!Array.isArray(data))
        return { findings: [], errors: ["指摘の JSON は配列にしてください"] };
    const findings = [];
    data.forEach((raw, i) => {
        const at = `findings[${i}]`;
        if (typeof raw !== "object" || raw === null) {
            errors.push(`${at} はオブジェクトにしてください`);
            return;
        }
        const f = raw;
        const path = text(f.path, `${at}.path`, errors, true);
        // バッククォートは `📍 \`path\`` の書式を壊し、対応側が別のパスを読む
        // `./x` や `a//b` は、git の `<rev>:<path>` の解決と 📍 の照合でずれるので受け付けない
        const oddSegments = path !== null && path.split("/").some((seg) => seg === "" || seg === ".");
        if (path !== null && (!isRepoRelativePath(path) || isUnsafePath(path) || /[\s`]/.test(path) || oddSegments)) {
            errors.push(`${at}.path はリポジトリのルートからの相対パスにしてください（絶対パス・..・./・\\・空白・'・\` は使えません）: ${JSON.stringify(path)}`);
        }
        if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1)
            errors.push(`${at}.line は 1 以上の整数にしてください`);
        const side = f.side ?? "new";
        if (side !== "new" && side !== "old")
            errors.push(`${at}.side は new か old にしてください`);
        if (!isFindingSeverity(f.severity) || f.severity === "none")
            errors.push(`${at}.severity は critical / warning / suggestion のどれかにしてください`);
        const kind = f.kind ?? "fix";
        if (kind !== "fix" && kind !== "question")
            errors.push(`${at}.kind は fix か question にしてください`);
        const title = text(f.title, `${at}.title`, errors, true);
        const expected = text(f.expected, `${at}.expected`, errors, kind === "fix");
        const background = text(f.background, `${at}.background`, errors, false);
        const evidence = text(f.evidence, `${at}.evidence`, errors, false);
        if (errors.length > 0)
            return;
        findings.push({
            path: path,
            line: f.line,
            side: side,
            severity: f.severity,
            kind: kind,
            title: title,
            expected,
            background,
            evidence,
        });
    });
    return { findings, errors };
}
/** 同じ指摘（場所と内容）に同じ ID を付け、再実行での二重投稿を防ぐ */
export function findingId(f) {
    return createHash("sha256").update(`${f.path}\0${f.line}\0${f.side}\0${f.title}`).digest("hex").slice(0, 12);
}
/**
 * コメントに誘導されたエージェントが、対応側のエージェントに向けた命令を書いていないかの目安（§4-5）。
 * 警告にとどめ、確認①で利用者が読む
 */
export function suspiciousPhrases(f) {
    const joined = [f.title, f.expected ?? "", f.background ?? ""].join("\n");
    const found = [];
    for (const [label, re] of [
        ["コマンドの実行を求める表現", /(?:実行|起動)(?:して|すること|せよ)|\bcurl\b|\bwget\b|\bnpm\s+(?:install|run)\b|\bnpx\b|\bbash\b|\bsh\s+-c\b/i],
        ["外部への送信を求める表現", /(?:送信|アップロード|投稿)(?:して|すること|せよ)|https?:\/\//i],
        ["資格情報に触れる表現", /api\s*key|apikey|BACKLOG_API_KEY|token|password|秘密鍵|パスワード|\.env\b|~\/\.ssh/i],
        ["確認の省略を求める表現", /確認(?:なし|せず|を省)|--yes|自動で(?:承認|投稿)/i],
    ]) {
        if (re.test(joined))
            found.push(label);
    }
    return found;
}
/** 本文に載せる文の無害化。`@` と `[review-bot` を崩し、見えない文字を取り除く */
export function safe(textValue) {
    return neutralize(textValue).replace(CONTROL, "");
}
/** §2-1 の書式に整える */
export function formatFinding(f) {
    const where = f.side === "old" ? `L${f.line}（変更前）` : `L${f.line}`;
    const lines = [
        `${FINDING_HEADLINE} ${SEVERITY_MARK[f.severity]}`,
        `📍 \`${safe(f.path)}\` ${where}`,
        `${f.kind === "question" ? "質問" : "指摘"}: ${safe(f.title)}`,
    ];
    if (f.expected)
        lines.push(`${f.kind === "question" ? "確認したいこと" : "期待"}: ${safe(f.expected)}`);
    if (f.background)
        lines.push(`背景: ${safe(f.background)}`);
    lines.push("", formatFindingMarker({ severity: f.severity }));
    return lines.join("\n");
}
/** 指摘が 0 件のときのコメント（§2-3） */
export function formatNoFindings(info) {
    return [
        `${FINDING_HEADLINE}: 指摘はありません`,
        `（レビューした範囲: 変更ファイル ${info.fileCount} 件、${safe(info.base)} ${info.baseCommit.slice(0, 7)} … ${safe(info.branch)} ${info.branchCommit.slice(0, 7)}）`,
        "",
        formatFindingMarker({ severity: "none" }),
    ].join("\n");
}
