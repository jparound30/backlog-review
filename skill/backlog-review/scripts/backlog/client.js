import { replaceFourByteChars } from "../text.js";
import { containsApiKey, findSecretPattern } from "./secrets.js";
export { findSecretPattern } from "./secrets.js";
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;
/** コメントの取得のページ数の上限（R-18）。1 ページ 100 件なので 10 万件まで */
const MAX_PAGES = 1_000;
/** 1 回の API 呼び出しの上限（応答がないまま止まらないように, S-11） */
const DEFAULT_TIMEOUT_MS = 30_000;
/** API キーを含まない形で URL を表示する（エラーやログに使う） */
function redact(url) {
    const copy = new URL(url);
    if (copy.searchParams.has("apiKey"))
        copy.searchParams.set("apiKey", "***");
    return copy.toString();
}
export class BacklogApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export class BacklogClient {
    space;
    apiKey;
    fetchImpl;
    sleep;
    timeoutMs;
    constructor(space, apiKey, options = {}) {
        this.space = space;
        this.apiKey = apiKey;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    buildUrl(path, query = {}) {
        const url = new URL(`https://${this.space}/api/v2${path}`);
        for (const [key, value] of Object.entries(query))
            url.searchParams.set(key, String(value));
        url.searchParams.set("apiKey", this.apiKey);
        return url;
    }
    /** レート制限のリセット時刻（X-RateLimit-Reset, UNIX 秒）まで待つ。不明なら指数バックオフ */
    retryDelay(res, attempt) {
        const reset = Number(res?.headers.get("X-RateLimit-Reset"));
        if (Number.isFinite(reset) && reset > 0) {
            return Math.min(Math.max(reset * 1000 - Date.now(), 1000), MAX_WAIT_MS);
        }
        return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
    }
    /**
     * GET は 429・5xx・通信エラーで再試行する。
     * POST / PATCH は二重投稿を避けるため、処理されていないことが確実な 429 のときだけ再試行する。
     */
    async request(method, url, body) {
        const idempotent = method === "GET";
        for (let attempt = 0;; attempt++) {
            let res;
            try {
                res = await this.fetchImpl(url, {
                    method,
                    // クエリに API キーが入っているので、リダイレクト先には送らない
                    redirect: "error",
                    signal: AbortSignal.timeout(this.timeoutMs),
                    body,
                    headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
                });
            }
            catch (error) {
                const timedOut = error instanceof Error && error.name === "TimeoutError";
                if (!idempotent && timedOut) {
                    // 投稿は届いている可能性があるので、再試行せずに確認を促す
                    throw new Error(`${method} ${redact(url)} → ${this.timeoutMs / 1000} 秒以内に応答がありませんでした。投稿されたか分からないため、status で確かめてから再実行してください`);
                }
                if (!idempotent || attempt >= MAX_RETRIES) {
                    const reason = timedOut ? `${this.timeoutMs / 1000} 秒以内に応答がありませんでした` : error instanceof Error ? error.message : String(error);
                    throw new Error(`${method} ${redact(url)} → 通信エラー: ${reason}`);
                }
                await this.sleep(this.retryDelay(undefined, attempt));
                continue;
            }
            const retryable = res.status === 429 || (idempotent && res.status >= 500);
            if (retryable && attempt < MAX_RETRIES) {
                await this.sleep(this.retryDelay(res, attempt));
                continue;
            }
            const text = await res.text();
            if (!res.ok) {
                throw new BacklogApiError(`${method} ${redact(url)} → HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
            }
            return JSON.parse(text);
        }
    }
    pullRequestPath(pr) {
        const project = encodeURIComponent(pr.projectKey);
        const repo = encodeURIComponent(pr.repoName);
        return `/projects/${project}/git/repositories/${repo}/pullRequests/${pr.number}`;
    }
    /** push する差分などを調べるため、外部に出す文字列に API キーが含まれるかを返す（キーそのものは外に出さない） */
    containsApiKey(content) {
        return containsApiKey(content, this.apiKey);
    }
    getMyself() {
        return this.request("GET", this.buildUrl("/users/myself"));
    }
    getPullRequest(pr) {
        return this.request("GET", this.buildUrl(this.pullRequestPath(pr)));
    }
    /**
     * コメントを古い順に全件取得する。
     * API が想定と違う応答をしても止まるよう、取得位置が進まなければ中止し、ページ数にも上限を設ける（R-18）
     */
    async listAllComments(pr) {
        const all = [];
        let minId;
        for (let pages = 0;; pages++) {
            if (pages >= MAX_PAGES) {
                throw new Error(`コメントが ${MAX_PAGES * PAGE_SIZE} 件を超えたため、取得を中止しました`);
            }
            const query = { count: PAGE_SIZE, order: "asc" };
            if (minId !== undefined)
                query.minId = minId;
            const page = await this.request("GET", this.buildUrl(`${this.pullRequestPath(pr)}/comments`, query));
            if (!Array.isArray(page))
                throw new Error("コメントの一覧の応答が配列ではありません");
            all.push(...page);
            if (page.length < PAGE_SIZE)
                return all;
            const next = page[page.length - 1].id + 1;
            if (!Number.isSafeInteger(next) || (minId !== undefined && next <= minId)) {
                throw new Error("コメントの取得位置が進まないため、取得を中止しました（API の応答が想定と違います）");
            }
            minId = next;
        }
    }
    /** API キーや秘密情報が本文に紛れ込んだまま投稿されるのを防ぐ（§6-1） */
    assertSafeContent(content) {
        if (containsApiKey(content, this.apiKey)) {
            throw new Error("投稿する本文に API キーが含まれているため、投稿を中止しました");
        }
        const secret = findSecretPattern(content);
        if (secret)
            throw new Error(`投稿する本文に秘密情報らしき文字列（${secret}）があるため、投稿を中止しました`);
    }
    /** 投稿・更新する本文。スペースによっては投稿できない 4 バイト文字を置き換える（plan.md §4-7） */
    async postComment(pr, body) {
        const content = replaceFourByteChars(body);
        this.assertSafeContent(content);
        return this.request("POST", this.buildUrl(`${this.pullRequestPath(pr)}/comments`), new URLSearchParams({ content }));
    }
    /** 認証ユーザー自身が投稿したコメントのみ更新できる */
    async updateComment(pr, commentId, body) {
        const content = replaceFourByteChars(body);
        this.assertSafeContent(content);
        return this.request("PATCH", this.buildUrl(`${this.pullRequestPath(pr)}/comments/${commentId}`), new URLSearchParams({ content }));
    }
}
