/**
 * PR の説明文の中の、サマリーの区画（plan.md §4-5-1）。
 * 区画の中だけを置き換え、PR の作成者が書いた部分には触れない。区画の中身は読まない（書くだけ）
 */
export const BLOCK_BEGIN = "<!-- review-bot summary begin -->";
export const BLOCK_END = "<!-- review-bot summary end -->";
function occurrences(text, needle) {
    const found = [];
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length))
        found.push(i);
    return found;
}
/** 区画を探す。印が 2 つ以上ある・片方だけある・順序が逆なら壊れているとして、何もしない */
export function locateBlock(description) {
    const begins = occurrences(description, BLOCK_BEGIN);
    const ends = occurrences(description, BLOCK_END);
    if (begins.length === 0 && ends.length === 0)
        return { kind: "none" };
    if (begins.length !== 1 || ends.length !== 1) {
        return { kind: "broken", reason: `区画の印が壊れています（始まり ${begins.length} 個・終わり ${ends.length} 個）` };
    }
    if (ends[0] < begins[0])
        return { kind: "broken", reason: "区画の印の順序が逆です（終わりが始まりより前にあります）" };
    return { kind: "one", start: begins[0], end: ends[0] + BLOCK_END.length };
}
/** 区画の中に置く文で、HTML のコメントの始まりと終わりを崩す（区画の印と取り違えないように） */
function neutralizeComment(text) {
    return text.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}
export function formatBlock(summary) {
    return `${BLOCK_BEGIN}\n${neutralizeComment(summary)}\n${BLOCK_END}`;
}
/** 区画を置き換えた説明文。区画がなければ末尾に足す。壊れていれば null */
export function applyBlock(description, block) {
    const at = locateBlock(description);
    if (at.kind === "broken")
        return null;
    if (at.kind === "none") {
        const head = description.replace(/\s+$/, "");
        return { description: head === "" ? block : `${head}\n\n${block}`, action: "append" };
    }
    return { description: description.slice(0, at.start) + block + description.slice(at.end), action: "replace" };
}
