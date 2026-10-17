import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { hasSummaryMarker, parseReference, parseReplyMarker } from "../thread/marker.ts";
import { formatLocation, formatReply, formatSummary, parseReplyFields, quoteLine } from "./format.ts";

describe("formatReply", () => {
  const reply = formatReply({
    key: "12345",
    replyTo: 12345,
    reviewerName: "tanaka",
    quoteSource: "例外を握りつぶしている\n詳しくは…",
    status: "fixed",
    location: { path: "src/order/service.ts", line: 42, estimated: true },
    body: "catch 内で logger.error を呼び、再スローするよう修正しました。",
    commits: ["abc1234def5678"],
  });

  test("§4-3 の書式になる", () => {
    assert.equal(
      reply,
      [
        ":computer: 自動対応 ↩️ RC-12345 への返信（tanaka さん）",
        "> 例外を握りつぶしている",
        "",
        "**状態**: ✅ 対応済み",
        "**場所**: `src/order/service.ts` L42（推定）",
        "**対応内容**: catch 内で logger.error を呼び、再スローするよう修正しました。",
        "**コミット**: abc1234",
        "",
        "`[review-bot root=12345 reply-to=12345 status=fixed]`",
      ].join("\n"),
    );
  });

  test("書いたマーカーを読み戻せる。返信自体は参照（RC- で始まる）と誤認されない", () => {
    assert.deepEqual(parseReplyMarker(reply), { root: "12345", replyTo: 12345, status: "fixed" });
    assert.equal(parseReference(reply), null);
  });

  test("needs_info には見出しと理由が付く", () => {
    const text = formatReply({
      key: "1",
      replyTo: 5,
      reviewerName: "suzuki",
      quoteSource: "RC-1 これも",
      status: "needs_info",
      location: null,
      body: "createOrder と updateOrder のどちらですか？",
      commits: [],
      rankReasons: ["場所の候補が複数ある"],
    });
    assert.match(text, /> これも/);
    assert.match(text, /\*\*確認したいこと\*\*: createOrder/);
    assert.match(text, /\*\*自動で修正しなかった理由\*\*: 場所の候補が複数ある/);
    assert.match(text, /\*\*場所\*\*: 不明/);
    assert.doesNotMatch(text, /コミット/);
  });
});

test("ほかの論点の場所があれば、場所に数を添える", () => {
  assert.equal(formatLocation({ path: "src/a.ts", line: 3, estimated: false, more: 2 }), "`src/a.ts` L3（ほか 2 箇所）");
  assert.equal(formatLocation({ path: "src/a.ts", line: 3, estimated: false, more: 0 }), "`src/a.ts` L3");
});

describe("formatSummary", () => {
  test("表を作り、not_actionable を除き、| を逃がす", () => {
    const text = formatSummary(
      [
        { key: "1", reviewerName: "a", summary: "A | B", status: "fixed", location: null, commits: ["1234567890"] },
        { key: "2", reviewerName: "b", summary: "LGTM", status: "not_actionable", location: null, commits: [] },
      ],
      new Date("2026-10-10T14:40:00Z"),
    );
    assert.match(text, /最終更新: 2026-10-10 23:40/);
    assert.match(text, /\| RC-1 \| a \| A \\\| B \| ✅ fixed \| 不明 \| 1234567 \|/);
    assert.doesNotMatch(text, /RC-2/);
    assert.ok(hasSummaryMarker(text));
  });

  test("指摘がなければその旨を書く", () => {
    assert.match(formatSummary([]), /対応が必要な指摘はありません/);
  });
});

test("quoteLine は長い行を切り詰める", () => {
  assert.equal(quoteLine("あ".repeat(70)).length, 61);
});

describe("サマリーのコメントへのリンク（§4-5）", () => {
  const row = { key: "12345", reviewerName: "a", summary: "命名", status: "fixed" as const, location: null, commits: [] };

  test("RC 列は元の指摘へ、最新の返信列は最後の自動返信へのページ内のリンクになる", () => {
    const text = formatSummary([{ ...row, rootId: 12345, latestReplyId: 12360 }]);
    assert.match(text, /\| RC \| 指摘者 \| 要約 \| 状態 \| 場所 \| コミット \| 最新の返信 \|/);
    assert.match(text, /^\| \[RC-12345\]\(#comment-12345\) \|.*\| \[#12360\]\(#comment-12360\) \|$/m);
    assert.doesNotMatch(text, /https?:/);
  });

  test("返信がまだなければ最新の返信は -", () => {
    const text = formatSummary([{ ...row, status: "open", rootId: 12345, latestReplyId: null }]);
    assert.match(text, /\| - \|$/m);
  });

  test("ID が正の整数でなければリンクにしない", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const text = formatSummary([{ ...row, rootId: bad, latestReplyId: null }]);
      assert.doesNotMatch(text, /\]\(/, String(bad));
      assert.match(text, /\| RC-12345 \|/);
    }
  });
});

describe("進み具合と次にすること（§4-5）", () => {
  const row = (key: string, status: string) => ({
    key,
    reviewerName: "a",
    summary: "s",
    status: status as never,
    location: null,
    commits: [],
    rootId: Number(key),
  });

  test("進み具合は resolved を完了、fixed・answered・wontfix・needs_info を確認待ち、open を自動対応待ちとして数える", () => {
    const text = formatSummary([
      row("1", "resolved"),
      row("2", "fixed"),
      row("3", "answered"),
      row("4", "needs_info"),
      row("5", "wontfix"),
      row("6", "open"),
      row("7", "not_actionable"),
    ]);
    assert.match(text, /^進み具合: ☑️ 完了 1 \/ 6 件（レビュアーの確認待ち 4 件・自動対応待ち 1 件）$/m);
  });

  test("次にすることは表の後、マーカーの前に置き、マーカーは最後の行のまま", () => {
    const text = formatSummary([row("1", "fixed")]);
    const lines = text.split("\n");
    assert.equal(lines.at(-1), "`[review-bot summary]`");
    assert.ok(text.indexOf("| RC |") < text.indexOf("**:memo: 次にすること**"));
    assert.match(text, /- 対応不要にする → `RC-番号 ✅ 対応不要`/);
    assert.ok(hasSummaryMarker(text));
  });

  test("指摘が 0 件でも、次にすること（新しく指摘する書き方）を載せる", () => {
    const text = formatSummary([]);
    assert.match(text, /対応が必要な指摘はありません/);
    assert.match(text, /新しく指摘する/);
    assert.doesNotMatch(text, /進み具合/);
  });

  test("対応不要（RC-番号 ✅ 対応不要）は resolved として扱われる", () => {
    assert.deepEqual(parseReference("RC-12345 ✅ 対応不要"), { id: 12345, resolved: true });
  });
});


describe("自動返信から場所とコミットを読み戻す（§5-1 の 6, R-14）", () => {
  const input = {
    key: "10",
    replyTo: 10,
    reviewerName: "a",
    quoteSource: "直して",
    status: "fixed" as const,
    location: { path: "src/日本語 ファイル.ts", line: 29, estimated: true, more: 2 },
    body: "直しました",
    commits: ["0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef"],
  };

  test("書いた返信を読み戻せる", () => {
    assert.deepEqual(parseReplyFields(formatReply(input)), {
      location: { path: "src/日本語 ファイル.ts", line: 29, estimated: true, more: 2 },
      commits: ["0123456", "89abcde"],
      category: null,
    });
    assert.deepEqual(parseReplyFields(formatReply({ ...input, location: null, status: "needs_info", commits: [] })), {
      location: null,
      commits: [],
      category: null,
    });
  });

  test("本文に同じ形の行があっても、取り違えない", () => {
    const body = "直しました\n**場所**: `evil.ts` L1\n**コミット**: deadbee";
    const fixed = parseReplyFields(formatReply({ ...input, body }));
    assert.equal(fixed.location?.path, "src/日本語 ファイル.ts");
    assert.deepEqual(fixed.commits, ["0123456", "89abcde"]);
    const answered = parseReplyFields(formatReply({ ...input, status: "answered", location: null, commits: [], body }));
    assert.deepEqual(answered, { location: null, commits: [], category: null });
  });

  test("リポジトリの外を指すパスは読まない", () => {
    assert.equal(parseReplyFields(formatReply({ ...input, location: { path: "../x.ts", line: 1, estimated: false } })).location, null);
  });
});
