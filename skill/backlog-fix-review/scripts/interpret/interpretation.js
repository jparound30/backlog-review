import { isRepoRelativePath, isUnsafePath } from "../text.js";
import { CATEGORY_CODES, isCategory } from "../thread/category.js";
import { parseItemKey } from "../thread/marker.js";
/** §3-2 手順 2 の種類（論点ごと） */
export const KINDS = ["fix", "answer", "needs_info", "wontfix", "not_actionable"];
/** §3-3 の判定 */
export const LOCATION_JUDGMENTS = ["explicit", "inferred_unique", "inferred_multiple", "unknown"];
export const INTENT_JUDGMENTS = ["clear", "ambiguous"];
export const SCOPE_JUDGMENTS = ["local", "local_with_docs", "wide"];
export const DOCS_REASON = "仕様書の更新が必要";
/**
 * 論点のランクを規則で決める（§3-3）。`fix` 以外には付けない。
 * エージェントの自己申告ではなく、判定の組み合わせだけで決まる。
 */
export function computeRank(input) {
    if (input.kind !== "fix")
        return { rank: null, reasons: [], fixableWithApproval: false };
    const low = [];
    if (input.location.judgment === "unknown")
        low.push("指摘の場所が特定できない");
    if (input.intent.judgment === "ambiguous")
        low.push("直し方が 1 通りに決まらない");
    if (low.length > 0)
        return { rank: "low", reasons: low, fixableWithApproval: false };
    const mid = [];
    if (input.location.judgment === "inferred_multiple")
        mid.push("場所の候補が複数ある");
    if (input.scope.judgment === "wide")
        mid.push("影響範囲が広い");
    if (input.scope.judgment === "local_with_docs")
        mid.push(DOCS_REASON);
    if (mid.length > 0) {
        return { rank: "mid", reasons: mid, fixableWithApproval: mid.length === 1 && mid[0] === DOCS_REASON };
    }
    return { rank: "high", reasons: [], fixableWithApproval: false };
}
const RANK_ORDER = ["low", "mid", "high"];
/**
 * 論点の組み合わせから、指摘全体のランクと返信の状態を決める（§3-3「論点と指摘全体」）。
 * 直し方の決まらない論点が 1 つでもあれば、どの論点も直さずに needs_info で聞く
 */
export function assessInterpretation(inputs) {
    const points = inputs.map((p) => {
        const { rank, reasons, fixableWithApproval } = computeRank(p);
        return { ...p, rank, rankReasons: reasons, fixableWithApproval };
    });
    const prefix = (i) => (points.length > 1 ? `論点 ${i + 1}: ` : "");
    const fixes = points.filter((p) => p.kind === "fix");
    const rank = fixes.length === 0 ? null : RANK_ORDER[Math.min(...fixes.map((p) => RANK_ORDER.indexOf(p.rank)))];
    // 利用者（レビュアー）の判断が要る論点
    const reasons = [];
    let onlyDocs = true;
    points.forEach((p, i) => {
        if (p.kind === "fix" && p.rank !== "high") {
            reasons.push(...p.rankReasons.map((r) => prefix(i) + r));
            if (!p.fixableWithApproval)
                onlyDocs = false;
        }
        else if (p.kind === "needs_info") {
            reasons.push(`${prefix(i)}確認が必要`);
            onlyDocs = false;
        }
    });
    const has = (kind) => points.some((p) => p.kind === kind);
    const wontfixMixed = has("wontfix") && (has("fix") || has("answer"));
    if (reasons.length > 0) {
        if (wontfixMixed)
            reasons.push("見送りたい論点がある（見送ってよいかの確認）");
        return { points, rank, rankReasons: reasons, fixableWithApproval: onlyDocs && !wontfixMixed, replyStatus: "needs_info" };
    }
    if (wontfixMixed) {
        return { points, rank, rankReasons: ["見送りたい論点がある（見送ってよいかの確認）"], fixableWithApproval: false, replyStatus: "needs_info" };
    }
    const replyStatus = has("fix") ? "fixed" : has("wontfix") ? "wontfix" : has("answer") ? "answered" : null;
    return { points, rank, rankReasons: [], fixableWithApproval: false, replyStatus };
}
/** この指摘に返信してよい状態（§3-1）。「利用者が選べば修正」なら、選ばれたとき fixed、選ばれなければ needs_info */
export function allowedReplyStatuses(assessment) {
    if (assessment.replyStatus === null)
        return [];
    return assessment.fixableWithApproval ? ["fixed", "needs_info"] : [assessment.replyStatus];
}
const isOneOf = (values, value) => typeof value === "string" && values.includes(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
function validatePoint(raw, at, needSummary, errors) {
    const r = raw;
    if (!r || typeof r !== "object") {
        errors.push(`${at} オブジェクトではありません`);
        return null;
    }
    const before = errors.length;
    if (!isOneOf(KINDS, r.kind))
        errors.push(`${at} kind が不正です: ${String(r.kind)}`);
    const loc = r.location;
    const intent = r.intent;
    const scope = r.scope;
    if (!loc || !isOneOf(LOCATION_JUDGMENTS, loc.judgment))
        errors.push(`${at} location.judgment が不正です`);
    if (loc && !isText(loc.reason))
        errors.push(`${at} location.reason がありません`);
    if (loc && loc.path !== null && loc.path !== undefined && typeof loc.path !== "string") {
        errors.push(`${at} location.path が不正です`);
    }
    // 改行・制御文字・シェルで安全に扱えない文字を含むパスは受け付けない（S-7）
    if (loc && typeof loc.path === "string" && isUnsafePath(loc.path)) {
        errors.push(`${at} location.path に使えない文字が含まれています: ${JSON.stringify(loc.path)}`);
    }
    else if (loc && typeof loc.path === "string" && !isRepoRelativePath(loc.path)) {
        // リポジトリの外を指すパスは受け付けない（R-5）
        errors.push(`${at} location.path はリポジトリのルートからの相対パスにしてください（絶対パス・.. は使えません）: ${JSON.stringify(loc.path)}`);
    }
    if (loc && loc.line !== null && loc.line !== undefined && !(Number.isInteger(loc.line) && loc.line > 0)) {
        errors.push(`${at} location.line が不正です`);
    }
    if (loc && (loc.judgment === "explicit" || loc.judgment === "inferred_unique") && !isText(loc.path)) {
        errors.push(`${at} 場所を特定したのに location.path がありません`);
    }
    if (!intent || !isOneOf(INTENT_JUDGMENTS, intent.judgment) || !isText(intent.reason)) {
        errors.push(`${at} intent が不正です（judgment と reason が必要）`);
    }
    if (!scope || !isOneOf(SCOPE_JUDGMENTS, scope.judgment) || !isText(scope.reason)) {
        errors.push(`${at} scope が不正です（judgment と reason が必要）`);
    }
    // local_with_docs なら、直す仕様書のパスが 1 つ以上必要。パスは location.path と同じ検査をする
    const docs = scope?.docs;
    if (docs !== undefined && (!Array.isArray(docs) || !docs.every((d) => isText(d) && !isUnsafePath(d) && isRepoRelativePath(d)))) {
        errors.push(`${at} scope.docs が不正です（リポジトリのルートからの安全な相対パスの配列が必要）`);
    }
    else if (scope?.judgment === "local_with_docs" && (!Array.isArray(docs) || docs.length === 0)) {
        errors.push(`${at} 影響範囲が local_with_docs なのに scope.docs（直す仕様書のパス）がありません`);
    }
    if (!isText(r.plan))
        errors.push(`${at} plan がありません`);
    if (r.summary !== undefined && typeof r.summary !== "string")
        errors.push(`${at} summary が不正です`);
    if (needSummary && !isText(r.summary))
        errors.push(`${at} 論点が複数あるときは summary（論点の要約）が必要です`);
    if (errors.length > before)
        return null;
    return {
        ...(isText(r.summary) ? { summary: r.summary } : {}),
        kind: r.kind,
        location: {
            judgment: loc.judgment,
            path: loc.path ?? null,
            line: loc.line ?? null,
            reason: loc.reason,
        },
        intent: { judgment: intent.judgment, reason: intent.reason },
        scope: {
            judgment: scope.judgment,
            reason: scope.reason,
            ...(Array.isArray(scope.docs) && scope.docs.length > 0 ? { docs: scope.docs } : {}),
        },
        plan: r.plan,
    };
}
/** エージェントが書いた解釈の JSON を検証する。問題があれば理由の一覧を返す */
export function validateInterpretations(data) {
    const errors = [];
    if (!Array.isArray(data))
        return { items: [], errors: ["配列ではありません"] };
    const items = [];
    const seen = new Set();
    data.forEach((raw, index) => {
        const at = `[${index}]`;
        const r = raw;
        if (!r || typeof r !== "object") {
            errors.push(`${at} オブジェクトではありません`);
            return;
        }
        const before = errors.length;
        const key = typeof r.key === "string" ? r.key.replace(/^RC-/, "") : "";
        if (key.includes("#")) {
            errors.push(`${at} 指摘は分割しません。key は RC-番号 にし、論点は points に並べてください: ${String(r.key)}`);
        }
        else if (!parseItemKey(key)) {
            errors.push(`${at} key が不正です: ${String(r.key)}`);
        }
        if (seen.has(key))
            errors.push(`${at} key が重複しています: ${key}`);
        seen.add(key);
        if (!Array.isArray(r.points) || r.points.length === 0) {
            errors.push(`${at} points（論点の配列）が必要です。論点が 1 つでも配列にしてください`);
            return;
        }
        if (r.category !== undefined && !isCategory(r.category)) {
            errors.push(`${at} category は ${CATEGORY_CODES.join(" / ")} のどれかにしてください: ${String(r.category)}`);
        }
        const multiple = r.points.length > 1;
        const points = r.points.map((p, i) => validatePoint(p, `${at}.points[${i}]`, multiple, errors));
        if (errors.length > before)
            return;
        items.push({ key, ...(isCategory(r.category) ? { category: r.category } : {}), points: points });
    });
    return { items, errors };
}
