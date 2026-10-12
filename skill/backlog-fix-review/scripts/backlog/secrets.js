/** 投稿や push で外に出す文字列に、API キーや秘密情報が紛れていないかを調べる（§6-1） */
const SECRET_PATTERNS = [
    ["秘密鍵", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["AWS のアクセスキー", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
    ["GitHub のトークン", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    // 先頭の文字と長さが決まっていて、普通のコードと取り違えにくいもの（R-11）
    ["GitHub のトークン", /\bgithub_pat_[A-Za-z0-9_]{22,}/],
    ["GitLab のトークン", /\bglpat-[A-Za-z0-9_-]{20,}/],
    ["Slack のトークン", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
    ["Anthropic の API キー", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
    ["OpenAI の API キー", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{48}\b/],
    ["Google の API キー", /\bAIza[0-9A-Za-z_-]{35}/],
    ["Stripe のキー", /\b[sr]k_live_[0-9A-Za-z]{20,}/],
];
// 行頭の空白は [ \t] に限る（\s だと改行も含み、改行が並ぶ入力で遅くなるため）
const SETTING_LINE = /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*[ \t]*=[ \t]*(.*)$/gm;
/**
 * 設定行の値が、秘密そのものではないもの（R-11）。
 * 数値（`MAX_TOKEN_LENGTH = 100`）、参照（環境変数・CI の秘密）、記入例、空の値
 */
export function isHarmlessSettingValue(raw) {
    const value = raw.trim().replace(/[;,]$/, "").replace(/^(["'`])(.*)\1$/, "$2").trim();
    if (value === "" || /^(?:null|None|nil|undefined|true|false)$/.test(value))
        return true;
    if (/^-?\d+(?:\.\d+)?$/.test(value))
        return true;
    if (/^(?:os\.environ|os\.getenv|process\.env|ENV\[|System\.getenv|getenv\(|\$\{|\$[A-Za-z_])/.test(value))
        return true;
    return /your[-_]|<[^>]*>|x{3,}|changeme|dummy|example|placeholder/i.test(value);
}
/** 秘密情報らしき文字列の種類を返す。なければ null */
export function findSecretPattern(content) {
    const found = SECRET_PATTERNS.find(([, pattern]) => pattern.test(content));
    if (found)
        return found[0];
    for (const m of content.matchAll(SETTING_LINE)) {
        if (!isHarmlessSettingValue(m[1]))
            return "秘密情報の設定行";
    }
    return null;
}
/**
 * 比べる前に、URL エンコードした文字（`%20` など）と、英数字以外（区切り文字・空白・ゼロ幅文字など）を取り除き、
 * 小文字にそろえる
 */
function normalize(text) {
    return text.replace(/%[0-9A-Fa-f]{2}/g, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}
/** `%XX` を文字に戻す。不正な並びはそのまま残す */
function decodePercent(text) {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
            return decodeURIComponent(run);
        }
        catch {
            return run;
        }
    });
}
/** 短すぎる形は、無関係な文字列と偶然一致しやすいので使わない */
const MIN_FORM_LENGTH = 12;
/**
 * API キーのよくある変形を作る（公開前チェック S-4）。
 * - そのまま、逆順
 * - 16 進数
 * - base64（前に 0〜2 バイトあるときの 3 通りのずれ。前後の、キー以外の値で変わる文字は除く）と、その URL 安全な形
 * URL エンコードや区切り文字を挟んだ形は、normalize で英数字だけにして比べることで見つける
 */
export function apiKeyForms(apiKey) {
    const key = Buffer.from(apiKey);
    const forms = new Set();
    const add = (form) => {
        const n = normalize(form);
        if (n.length >= MIN_FORM_LENGTH)
            forms.add(n);
    };
    add(apiKey);
    add([...apiKey].reverse().join(""));
    add(key.toString("hex"));
    for (let offset = 0; offset < 3; offset++) {
        const encoded = Buffer.concat([Buffer.alloc(offset), key]).toString("base64");
        // 1 文字は 6 ビット。キーのビットだけで決まる文字の範囲を取り出す
        const middle = encoded.slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + key.length)) / 6));
        add(middle);
        add(middle.replace(/\+/g, "-").replace(/\//g, "_"));
    }
    return [...forms];
}
/**
 * API キーそのもの、またはよくある変形を含むか。
 * よくある形を見つけるためのもので、意図して変形したものをすべて見つけられるわけではない
 */
export function containsApiKey(content, apiKey) {
    if (apiKey === "")
        return false;
    if (content.includes(apiKey))
        return true;
    // すべての文字を URL エンコードした形（`%41%62…`）も見つけられるよう、デコードした文字列とも比べる
    const decoded = decodePercent(content);
    const targets = [normalize(content), normalize(decoded)];
    return apiKeyForms(apiKey).some((form) => targets.some((target) => target.includes(form)));
}
/** 漏れの種類（"API キー" または秘密情報の種類）を返す。なければ null */
export function findLeak(content, apiKey) {
    return containsApiKey(content, apiKey) ? "API キー" : findSecretPattern(content);
}
