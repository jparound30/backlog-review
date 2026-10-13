import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { BacklogClient } from "./backlog/client.ts";
import { parseBodyMarkers } from "./context.ts";
import { REPLY_STATUSES } from "./thread/marker.ts";
import { formatReply, formatSummary } from "./reply/format.ts";
import { formatFinding, formatNoFindings, safe, validateFindings } from "./review/finding.ts";
import { formatResolution } from "./review/commands.ts";
import { replaceFourByteChars } from "./text.ts";

// スペースによっては、UTF-8 の 4 バイト文字を含むコメントを API が拒否する（plan.md §2, §4-7）
const FOUR_BYTE = /[\u{10000}-\u{10FFFF}]/u;

const PR = { space: "example.backlog.jp", projectKey: "PROJ", repoName: "repo", number: 1 };

describe("4 バイト文字の置き換え（§4-7）", () => {
  test("U+10000 以上だけを U+XXXX にし、3 バイト以下の文字は残す", () => {
    assert.equal(replaceFourByteChars("直しました🎉 ✅ ☑️ ⚠ 日本語"), "直しましたU+1F389 ✅ ☑️ ⚠ 日本語");
    assert.equal(replaceFourByteChars("𠮷野家"), "U+20BB7野家");
    assert.equal(replaceFourByteChars("`[review-bot summary]`"), "`[review-bot summary]`");
  });

  test("API クライアントは投稿・更新の直前に置き換える", async () => {
    const bodies: string[] = [];
    const impl = (async (_url: URL, init?: RequestInit) => {
      bodies.push(new URLSearchParams(String(init?.body)).get("content") ?? "");
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: async () => {} });
    await client.postComment(PR, "🤖 自動対応 🎉");
    await client.updateComment(PR, 5, "## 🤖 サマリー");
    assert.deepEqual(bodies, ["U+1F916 自動対応 U+1F389", "## U+1F916 サマリー"]);
  });

  test("投稿する書式（返信・サマリー・指摘・指摘なし）に 4 バイト文字を入れない", () => {
    for (const status of REPLY_STATUSES) {
      const reply = formatReply({ key: "1", replyTo: 1, reviewerName: "a", quoteSource: "x", status, location: null, body: "y", commits: [] });
      assert.doesNotMatch(reply, FOUR_BYTE, status);
    }
    const statuses = ["open", "fixed", "answered", "needs_info", "wontfix", "resolved"] as const;
    const summary = formatSummary(statuses.map((status, i) => ({ key: String(i + 1), reviewerName: "a", summary: "s", status, location: null, commits: [] })));
    assert.doesNotMatch(summary, FOUR_BYTE);
    assert.match(summary, /^## :computer: レビュー対応状況/);
    for (const severity of ["critical", "warning", "suggestion"]) {
      const f = validateFindings([{ path: "src/a.ts", line: 1, severity, title: "t", expected: "e" }]).findings[0];
      assert.doesNotMatch(formatFinding(f), FOUR_BYTE, severity);
    }
    assert.doesNotMatch(formatNoFindings({ fileCount: 1, baseCommit: "a".repeat(40), branchCommit: "b".repeat(40), base: "main", branch: "f" }), FOUR_BYTE);
  });

  test("エージェントが書いた文の絵文字も、指摘の本文では置き換わる（重複の検査で投稿済みの本文と比べられる）", () => {
    assert.equal(safe("落ちる🔥"), "落ちるU+1F525");
    const f = validateFindings([{ path: "src/a.ts", line: 1, severity: "warning", title: "落ちる🔥", expected: "直す" }]).findings[0];
    assert.match(formatFinding(f), /^指摘: 落ちるU\+1F525$/m);
  });
});

describe("本文の場所の印（§4-2, §4-7）", () => {
  test("行の先頭の `場所:` を読む。全角のコロン・バッククォート・全角の L も受け付ける", () => {
    assert.deepEqual(parseBodyMarkers("場所: src/a.ts L42\n指摘: x"), [{ path: "src/a.ts", line: 42 }]);
    assert.deepEqual(parseBodyMarkers("RC-1 直っていません\n  場所： `src/a.ts` Ｌ3"), [{ path: "src/a.ts", line: 3 }]);
  });

  test("以前の書式の 📍 と、絵文字の記法 :round_pushpin: / :pushpin: も読む", () => {
    assert.deepEqual(parseBodyMarkers("📍 `src/a.ts` L1"), [{ path: "src/a.ts", line: 1 }]);
    assert.deepEqual(parseBodyMarkers("RC-1 :round_pushpin: src/a.ts L2 も"), [{ path: "src/a.ts", line: 2 }]);
    assert.deepEqual(parseBodyMarkers(":pushpin: src/b.ts L3"), [{ path: "src/b.ts", line: 3 }]);
  });

  test("行の途中の「場所:」と、自動対応の返信の **場所** は場所の印にしない", () => {
    assert.deepEqual(parseBodyMarkers("この場所: src/a.ts L1 は"), []);
    assert.deepEqual(parseBodyMarkers("**場所**: `src/a.ts` L42（推定）"), []);
    assert.deepEqual(parseBodyMarkers("> 場所: src/a.ts L42"), []);
  });

  test("リポジトリの外を指すパスは読まない", () => {
    assert.deepEqual(parseBodyMarkers("場所: ../x.ts L1\n場所: /etc/passwd L1"), []);
  });
});

describe("下書きと投稿の本文をそろえる（§4-7）", () => {
  test("返信・サマリー・再レビューの書式は、エージェントの文の 4 バイト文字を置き換えた形で下書きにする", () => {
    const reply = formatReply({ key: "1", replyTo: 1, reviewerName: "a", quoteSource: "x", status: "fixed", location: null, body: "直しました🎉", commits: ["abc1234"] });
    assert.match(reply, /\*\*対応内容\*\*: 直しましたU\+1F389$/m);
    assert.doesNotMatch(formatResolution("1", "resolve", "確認しました👍"), FOUR_BYTE);
    assert.match(formatResolution("1", "reopen", "まだです"), /^RC-1 :computer: 自動レビュー: まだです$/);
  });
});
