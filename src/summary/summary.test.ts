import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { BacklogApiError, BacklogClient } from "../backlog/client.ts";
import type { BacklogComment } from "../backlog/types.ts";
import { type CommandContext, summaryCommand } from "../commands.ts";
import { runGit } from "../git/git.ts";
import { formatReply } from "../reply/format.ts";
import { reviewSummaryCommand } from "../review/commands.ts";
import { SUMMARY_MARKER_TEXT } from "../thread/marker.ts";
import { applyBlock, BLOCK_BEGIN, BLOCK_END, formatBlock, locateBlock } from "./description.ts";
import { MOVED_NOTE } from "./command.ts";

describe("説明文のサマリーの区画（plan.md §4-5-1）", () => {
  const block = formatBlock("## サマリー");

  test("区画を探す。印が壊れていれば broken", () => {
    assert.deepEqual(locateBlock("説明だけ"), { kind: "none" });
    assert.equal(locateBlock(`前\n${block}\n後`).kind, "one");
    assert.equal(locateBlock(`${block}\n${block}`).kind, "broken");
    assert.equal(locateBlock(`前\n${BLOCK_BEGIN}\n後`).kind, "broken");
    assert.equal(locateBlock(`前\n${BLOCK_END}\n後`).kind, "broken");
    assert.match((locateBlock(`${BLOCK_END}\n${BLOCK_BEGIN}`) as { reason: string }).reason, /順序が逆/);
  });

  test("区画がなければ末尾に足し、あれば中だけを置き換える。作成者の部分は 1 文字も変えない", () => {
    assert.deepEqual(applyBlock("", block), { description: block, action: "append" });
    assert.deepEqual(applyBlock("作成者の説明\n\n\n", block), { description: `作成者の説明\n\n${block}`, action: "append" });
    const author = "作成者の説明 \u{1F389}\r\n- 箇条書き\r\n";
    const tail = "\r\n\r\n追記 \u{1F680}";
    const replaced = applyBlock(`${author}${formatBlock("古い")}${tail}`, block)!;
    assert.equal(replaced.action, "replace");
    assert.equal(replaced.description, `${author}${block}${tail}`);
    assert.equal(applyBlock(`${block}${block}`, block), null);
  });

  test("区画の中の文で、HTML のコメントの印を崩す", () => {
    const b = formatBlock(`| x | <!-- review-bot summary end --> |`);
    assert.equal(locateBlock(b).kind, "one");
    assert.ok(b.includes("&lt;!-- review-bot summary end --&gt;"));
  });

  test("API クライアントは、作成者の部分を変えず・検査せず、区画だけを検査して説明文を送る", async () => {
    let sent: URLSearchParams | undefined;
    const client = new BacklogClient("x.backlog.jp", "secret-api-key-0123456789", {
      fetchImpl: (async (_url: URL, init: RequestInit) => {
        sent = init.body as URLSearchParams;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const pr = { space: "x.backlog.jp", projectKey: "P", repoName: "r", number: 1 };
    const author = `記入例: ghp_${"a".repeat(36)} \u{1F389}\n`;
    await client.updatePullRequestDescription(pr, `${author}${block}`, block);
    assert.equal(sent?.get("description"), `${author}${block}`);
    assert.deepEqual([...sent!.keys()], ["description"]);
    const leaking = formatBlock("secret-api-key-0123456789");
    await assert.rejects(client.updatePullRequestDescription(pr, leaking, leaking), /API キー/);
    await assert.rejects(client.updatePullRequestDescription(pr, author, block), /区画が含まれていません/);
  });
});

describe("summary（plan.md §4-5-1, M17・R11）", () => {
  const PR = { space: "x.backlog.jp", projectKey: "P", repoName: "r", number: 1 };
  const AUTHOR = 1;
  const REVIEWER = 2;
  let repo: string;
  let comments: BacklogComment[];
  let pullRequests: Array<{ description: string; updated: string }>;
  let patched: string[];
  let updatedComments: Array<{ id: number; body: string }>;
  let postedComments: string[];
  let patchError: Error | null;
  const out: string[] = [];

  const comment = (id: number, user: number, content: string): BacklogComment => ({
    id,
    content,
    createdUser: { id: user, userId: null, name: `user${user}` },
    created: "2026-10-12T00:00:00Z",
    updated: "2026-10-12T00:00:00Z",
  });
  const client = (myself: number) =>
    ({
      getMyself: async () => ({ id: myself, userId: null, name: `user${myself}` }),
      // 呼ぶたびに次の状態を返す（最後のものを繰り返す）。取得し直しの間の編集を再現する
      getPullRequest: async () => {
        const next = pullRequests.length > 1 ? pullRequests.shift()! : pullRequests[0];
        return { summary: "s", base: "main", branch: "feature", status: { id: 1, name: "Open" }, createdUser: { id: AUTHOR }, ...next };
      },
      listAllComments: async () => comments,
      updatePullRequestDescription: async (_pr: unknown, description: string) => {
        if (patchError) throw patchError;
        patched.push(description);
        return {};
      },
      updateComment: async (_pr: unknown, id: number, body: string) => {
        updatedComments.push({ id, body });
        return { id };
      },
      postComment: async (_pr: unknown, body: string) => {
        postedComments.push(body);
        return { id: 900 };
      },
    }) as unknown as BacklogClient;
  const ctx = (myself: number): CommandContext => ({ client: client(myself), repoDir: repo, stateRoot: repo, out: (l) => out.push(l) });
  const run = async (side: "fix" | "review", post: boolean) => {
    out.length = 0;
    if (side === "fix") await summaryCommand(PR, post, ctx(AUTHOR));
    else await reviewSummaryCommand(PR, post, ctx(REVIEWER));
    return out.join("\n");
  };
  const fixed = formatReply({ key: "10", replyTo: 10, reviewerName: "user2", quoteSource: "q", status: "answered", location: null, body: "答えます", commits: [] });

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-summary-"));
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "base\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feature.ts"), "feature\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
  });
  after(async () => rm(repo, { recursive: true, force: true }));
  beforeEach(async () => {
    await rm(join(repo, ".review-state"), { recursive: true, force: true });
    comments = [comment(10, REVIEWER, "なぜこうしたのですか"), comment(11, AUTHOR, fixed), comment(12, REVIEWER, "RC-10 ✅")];
    pullRequests = [{ description: "作成者の説明 \u{1F389}", updated: "2026-10-12T00:00:00Z" }];
    patched = [];
    updatedComments = [];
    postedComments = [];
    patchError = null;
  });

  test("下書きでは変わる区画を見せるだけ。下書きなしの --yes は反映しない", async () => {
    const text = await run("fix", false);
    assert.match(text, /PR の説明文の末尾に、サマリーの区画を足します/);
    assert.match(text, /☑️ 完了 1 \/ 1 件/);
    assert.match(text, /サマリーコメントとして新規に反映します/);
    assert.equal(patched.length + updatedComments.length + postedComments.length, 0);
    await rm(join(repo, ".review-state"), { recursive: true, force: true });
    await assert.rejects(run("fix", true), /下書き（--yes なし）を表示していないか/);
    assert.equal(patched.length, 0);
  });

  test("下書きの後に返信が投稿されても（区画の中身が変わっても）、説明文が同じなら反映できる。中身は新しい状態で作る", async () => {
    comments = [comment(10, REVIEWER, "なぜこうしたのですか")];
    assert.match(await run("fix", false), /自動対応待ち 1 件/);
    comments.push(comment(11, AUTHOR, fixed));
    await run("fix", true);
    assert.match(patched[0], /レビュアーの確認待ち 1 件/);
  });

  test("--yes で説明文に反映し、以前の自分のサマリーコメントを「移しました」に書き換える", async () => {
    comments.push(comment(30, AUTHOR, `## 古いサマリー\n\n${SUMMARY_MARKER_TEXT}`));
    assert.match(await run("fix", false), /以前のサマリーコメント #30 を「説明文に移しました」の文に書き換えます/);
    await run("fix", true);
    assert.equal(patched.length, 1);
    assert.ok(patched[0].startsWith("作成者の説明 \u{1F389}\n\n<!-- review-bot summary begin -->\n## :computer: レビュー対応状況"));
    assert.ok(patched[0].endsWith(BLOCK_END));
    assert.doesNotMatch(patched[0], /\[review-bot summary\]/);
    assert.deepEqual(updatedComments, [{ id: 30, body: MOVED_NOTE }]);
    assert.equal(postedComments.length, 0);

    // 次からは、書き換えたコメントには触れず、区画を置き換える
    comments = comments.map((c) => (c.id === 30 ? { ...c, content: MOVED_NOTE } : c));
    pullRequests = [{ description: patched[0], updated: "2026-10-17T00:00:00Z" }];
    updatedComments = [];
    assert.match(await run("fix", false), /サマリーの区画を置き換えます/);
    await run("fix", true);
    assert.equal(patched.length, 2);
    assert.equal(updatedComments.length, 0);
    assert.equal(locateBlock(patched[1]).kind, "one");
  });

  test("下書きの後に説明文が編集されていれば、上書きせずに止める", async () => {
    await run("fix", false);
    pullRequests = [{ description: "作成者が書き換えた", updated: "2026-10-17T01:00:00Z" }];
    await assert.rejects(run("fix", true), /その後に PR の説明文が編集された/);
    // --yes の取得の後、更新の直前に編集された
    pullRequests = [{ description: "作成者の説明 \u{1F389}", updated: "2026-10-12T00:00:00Z" }];
    await run("fix", false);
    pullRequests = [
      { description: "作成者の説明 \u{1F389}", updated: "2026-10-12T00:00:00Z" },
      { description: "作成者の説明 \u{1F389} 追記", updated: "2026-10-17T02:00:00Z" },
    ];
    await assert.rejects(run("fix", true), /下書きの後に編集されています/);
    assert.equal(patched.length, 0);
  });

  test("説明文を更新できなければ（API が 4xx）、対応側はサマリーコメント、レビュー側は何も投稿しない", async () => {
    patchError = new BacklogApiError("PATCH … → HTTP 403: forbidden", 403);
    await run("fix", false);
    const fixText = await run("fix", true);
    assert.match(fixText, /PR の説明文を更新できませんでした: .*403/);
    assert.equal(postedComments.length, 1);
    assert.match(postedComments[0], /\[review-bot summary\]`$/);

    await run("review", false);
    const reviewText = await run("review", true);
    assert.match(reviewText, /サマリーコメントは投稿しません/);
    assert.equal(postedComments.length, 1);
  });

  test("通信エラーなど、更新されたか分からないエラーではコメントに切り替えない", async () => {
    patchError = new Error("PATCH … → 30 秒以内に応答がありませんでした");
    await run("fix", false);
    await assert.rejects(run("fix", true), /応答がありませんでした/);
    assert.equal(postedComments.length, 0);
  });

  test("区画が壊れていれば、対応側はサマリーコメント、レビュー側は止める", async () => {
    pullRequests = [{ description: `説明\n${BLOCK_BEGIN}\n途中で消えた`, updated: "2026-10-12T00:00:00Z" }];
    assert.match(await run("fix", false), /説明文を更新できないため（区画の印が壊れています.*サマリーコメントを新規に投稿します/s);
    await run("fix", true);
    assert.equal(patched.length, 0);
    assert.equal(postedComments.length, 1);

    assert.match(await run("review", false), /サマリーコメントは投稿しません/);
    await assert.rejects(run("review", true), /PR の説明文を更新できません/);
    assert.equal(postedComments.length, 1);
  });

  test("表の要約は省略しない（説明文の区画とサマリーコメントの両方）", async () => {
    const long = `${"とても長い指摘の最初の行。".repeat(20)}ここまで`;
    comments = [comment(40, REVIEWER, `${long}\n2 行目`)];
    await run("fix", false);
    await run("fix", true);
    assert.ok(patched[0].includes(long));
    assert.doesNotMatch(patched[0], /…/);
    patchError = new BacklogApiError("PATCH … → HTTP 403: forbidden", 403);
    await run("fix", false);
    await run("fix", true);
    assert.ok(postedComments[0].includes(long));
  });

  test("どちらのスキルで更新しても、区画の内容は同じ", async () => {
    // 他人（対応側）の返信も、レビュー側から読む
    comments.push(comment(20, REVIEWER, "変数名を直して"), comment(21, AUTHOR, formatReply({ key: "20", replyTo: 20, reviewerName: "user2", quoteSource: "q", status: "fixed", location: { path: "feature.ts", line: 1, estimated: false }, body: "直しました", commits: ["0123456789abcdef0123456789abcdef01234567"] })));
    await run("fix", false);
    await run("fix", true);
    await run("review", false);
    await run("review", true);
    assert.equal(patched.length, 2);
    const strip = (s: string) => s.replace(/最終更新: [^）]+/, "");
    assert.equal(strip(patched[1]), strip(patched[0]));
    assert.match(patched[0], /\| \[RC-20\]\(#comment-20\) \| user2 \| 変数名を直して \| ✅ fixed \| `feature\.ts` L1 \| 0123456 \| \[#21\]\(#comment-21\) \|/);
  });
});
