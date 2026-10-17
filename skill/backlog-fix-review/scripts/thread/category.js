/**
 * 指摘の分類（§4-8）。品質記録で指摘の種類ごとの件数を出すためだけに使い、
 * ランク・返信の状態・自動修正の対象の判定には使わない。
 * マーカーの書式は変えず、本文の決まった行（`分類:` / `**分類**:`）に書く（以前の版との互換性のため）
 */
export const CATEGORIES = [
    { code: "logic", label: "機能・ロジック" },
    { code: "error_handling", label: "エラー処理" },
    { code: "security", label: "セキュリティ" },
    { code: "performance", label: "性能" },
    { code: "design", label: "設計・保守性" },
    { code: "convention", label: "規約・書式" },
    { code: "test", label: "テスト" },
    { code: "docs", label: "ドキュメント" },
    { code: "other", label: "その他" },
];
export const CATEGORY_CODES = CATEGORIES.map((c) => c.code);
export function isCategory(value) {
    return typeof value === "string" && CATEGORY_CODES.includes(value);
}
export function categoryLabel(code) {
    return CATEGORIES.find((c) => c.code === code).label;
}
/** 全角・半角の揺れ（§4-2 と同じく NFKC）と空白をそろえる */
function normalize(text) {
    return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
/** 表示名かコードから分類を読む。一覧にないものは null（分類なしとして扱う） */
export function categoryFromText(text) {
    const value = normalize(text);
    const found = CATEGORIES.find((c) => normalize(c.label) === value || c.code === value);
    return found ? found.code : null;
}
/** 指摘の本文の `分類: エラー処理` の行（最初のもの）。人間が書いたものも、自動レビューの指摘も読む */
const ROOT_LINE = /^[ \t]*分類[ \t]*:(.*)$/m;
export function parseCategoryLine(content) {
    // NFKC で全角の `：` も `:` になる
    const m = ROOT_LINE.exec(content.normalize("NFKC"));
    return m ? categoryFromText(m[1]) : null;
}
/** 自動レビューの指摘に書く行（plan-review.md §2-1） */
export function formatCategoryLine(code) {
    return `分類: ${categoryLabel(code)}`;
}
/** 自動返信に書く行（§4-3。`**場所**:` の次） */
export function formatReplyCategoryLine(code) {
    return `**分類**: ${categoryLabel(code)}`;
}
/** 自動返信の `**分類**:` の行を読む。決まった位置の行だけを渡すこと */
export function parseReplyCategoryLine(line) {
    const m = /^\*\*分類\*\*: (.+)$/.exec(line.trim());
    return m ? categoryFromText(m[1]) : null;
}
