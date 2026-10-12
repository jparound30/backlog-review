import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BacklogComment } from "../backlog/types.ts";
import { formatReplyMarker, parseReference, parseReplyMarker } from "./marker.ts";
import { buildThreads } from "./thread.ts";

const ME = 1;
const OTHER = 2;
let nextTime = 0;

function c(id: number, user: number, content: string, extra: Partial<BacklogComment> = {}): BacklogComment {
  const t = new Date(Date.UTC(2026, 9, 10, 0, 0, nextTime++)).toISOString();
  return { id, content, createdUser: { id: user, userId: null, name: `user${user}` }, created: t, updated: t, ...extra };
}

const reply = (id: number, root: string, replyTo: number, status: string) =>
  c(id, ME, `🤖 自動対応 ↩️ RC-${root} への返信\n\n${formatReplyMarker({ root, replyTo, status: status as never })}`);

const statusOf = (comments: BacklogComment[], opts = {}) =>
  Object.fromEntries(
    buildThreads(comments, { myselfId: ME, ...opts }).threads.map((t) => [t.item.key, t.item.status]),
  );

describe("marker", () => {
  test("返信のマーカーを読み書きする", () => {
    const text = formatReplyMarker({ root: "12", replyTo: 15, status: "needs_info" });
    assert.equal(text, "`[review-bot root=12 reply-to=15 status=needs_info]`");
    assert.deepEqual(parseReplyMarker(`本文\n${text}`), { root: "12", replyTo: 15, status: "needs_info" });
  });

  test("以前の分割したマーカー（root=12#2）は、#数字 を無視して root 全体として読む（§4-1）", () => {
    assert.deepEqual(parseReplyMarker("`[review-bot root=12#2 reply-to=15 status=fixed]`"), { root: "12", replyTo: 15, status: "fixed" });
  });

  test("不正な状態のマーカーは無視する", () => {
    assert.equal(parseReplyMarker("`[review-bot root=1 reply-to=1 status=done]`"), null);
  });

  test("先頭の RC- と ✅ を読む", () => {
    assert.deepEqual(parseReference("RC-123 ✅"), { id: 123, resolved: true });
    assert.deepEqual(parseReference("\nRC-123#2 まだ直っていません"), { id: 123, resolved: false });
    assert.equal(parseReference("本文の途中の RC-123 は参照ではない"), null);
  });

  test("全角・ハイフンに似た文字・小文字で書かれた番号も読む（R-6）", () => {
    for (const text of ["ＲＣ－１２３ ✅", "RC−123 ✅", "RC‐123 ✅", "RC–123 ✅", "RCー123 ✅", "rc-123 ✅", "Rc－123：✅"]) {
      assert.deepEqual(parseReference(text), { id: 123, resolved: true }, text);
    }
    assert.deepEqual(parseReference("ＲＣ－１２３ まだです"), { id: 123, resolved: false });
    assert.equal(parseReference("ＲＣは参照ではない"), null);
  });

  test("解決の印は ✅ のほか、似た記号と絵文字の記法も受け付ける（R-6）", () => {
    for (const mark of ["✅", "✔", "✔️", "☑", "☑️", "✓", ":white_check_mark:", ":heavy_check_mark:", ":ballot_box_with_check:"]) {
      assert.equal(parseReference(`RC-123 ${mark}`)?.resolved, true, mark);
      assert.equal(parseReference(`RC-123${mark} 対応不要`)?.resolved, true, mark);
    }
    for (const text of ["RC-123 済みではないです", "RC-123 ✖", "RC-123 まだです ✅", "RC-123 :x:"]) {
      assert.equal(parseReference(text)?.resolved, false, text);
    }
  });
});

describe("buildThreads", () => {
  test("返信がなければ open", () => {
    assert.deepEqual(statusOf([c(10, OTHER, "変数名がわかりにくい")]), { "10": "open" });
  });

  test("Bot の返信の状態を反映し、✅ で resolved", () => {
    const comments = [c(10, OTHER, "指摘"), reply(11, "10", 10, "fixed")];
    assert.deepEqual(statusOf(comments), { "10": "fixed" });
    assert.deepEqual(statusOf([...comments, c(12, OTHER, "RC-10 ✅")]), { "10": "resolved" });
  });

  test("✅ のない返信は open に戻す", () => {
    const comments = [c(10, OTHER, "指摘"), reply(11, "10", 10, "needs_info"), c(12, OTHER, "RC-10 L42 のことです")];
    assert.deepEqual(statusOf(comments), { "10": "open" });
  });

  test("自分のマーカーなしのコメントも通常の指摘として扱う（§4-6）", () => {
    const { threads, roles } = buildThreads([c(10, ME, "戻り値の型がない")], { myselfId: ME });
    assert.equal(roles.get(10), "review");
    assert.equal(threads[0].item.status, "open");
  });

  test("他人が書いたマーカーは信用しない（§4-6）", () => {
    const comments = [c(10, OTHER, "指摘"), c(11, OTHER, formatReplyMarker({ root: "10", replyTo: 10, status: "fixed" }))];
    const { roles } = buildThreads(comments, { myselfId: ME });
    assert.equal(roles.get(11), "review");
    assert.equal(statusOf(comments)["10"], "open");
  });

  test("Bot の返信の ID を参照しても同じスレッドになる", () => {
    const comments = [c(10, OTHER, "指摘"), reply(11, "10", 10, "fixed"), c(12, OTHER, "RC-11 ✅")];
    assert.deepEqual(statusOf(comments), { "10": "resolved" });
  });

  test("以前の分割した返信や参照は、指摘全体のものとして扱う（R-2, §7-8）", () => {
    const comments = [
      c(10, OTHER, "1. 命名\n2. 例外処理"),
      reply(11, "10#1", 10, "fixed"),
      reply(12, "10#2", 10, "needs_info"),
    ];
    // 最後の返信の状態が、指摘全体の状態になる。状態ファイルがなくても同じ
    assert.deepEqual(statusOf(comments), { "10": "needs_info" });
    assert.deepEqual(statusOf([...comments, c(13, OTHER, "RC-10#2 例外はログ出力で")]), { "10": "open" });
    assert.deepEqual(statusOf([...comments, c(13, OTHER, "RC-11 ✅")]), { "10": "resolved" });
  });

  test("存在しない番号を書いても、偽の指摘はできない（R-13）", () => {
    assert.deepEqual(statusOf([c(20, OTHER, "直して"), c(21, OTHER, "RC-20#3 補足です")]), { "20": "open" });
  });

  test("ローカルの解釈で not_actionable を反映する。新しい人間のコメントがあれば open に戻す", () => {
    const interpretations = new Map([["10", { replyStatus: null, lastHumanCommentId: 10 }]]);
    assert.deepEqual(statusOf([c(10, OTHER, "LGTM")], { interpretations }), { "10": "not_actionable" });
    assert.deepEqual(statusOf([c(10, OTHER, "LGTM"), c(11, OTHER, "RC-10 やっぱり直して")], { interpretations }), { "10": "open" });
    const fix = new Map([["10", { replyStatus: "fixed" as const, lastHumanCommentId: 10 }]]);
    assert.deepEqual(statusOf([c(10, OTHER, "指摘")], { interpretations: fix }), { "10": "open" });
  });

  test("参照先が見つからない RC- は新しい指摘として扱い、警告を出す", () => {
    const { threads, warnings } = buildThreads([c(10, OTHER, "RC-999 これは？")], { myselfId: ME });
    assert.equal(threads.length, 1);
    assert.match(warnings[0].message, /RC-999/);
  });

  test("サマリーと、返信先のない Bot の返信を区別する", () => {
    const comments = [c(10, ME, "## 状況\n`[review-bot summary]`"), reply(11, "0", 0, "fixed")];
    const { threads, roles, summaryCommentId, warnings } = buildThreads(comments, { myselfId: ME });
    assert.equal(threads.length, 0);
    assert.equal(summaryCommentId, 10);
    assert.equal(roles.get(11), "ignored");
    assert.equal(warnings.length, 1);
  });

  test("返信後に root が編集されたら editedAfterReply", () => {
    const root = c(10, OTHER, "指摘");
    const r = reply(11, "10", 10, "fixed");
    root.updated = new Date(Date.parse(r.created) + 1000).toISOString();
    const { threads } = buildThreads([root, r], { myselfId: ME });
    assert.equal(threads[0].editedAfterReply, true);
  });

  test("テスト用 PR の実データ（DEMO #3）", async () => {
    const comments = JSON.parse(
      await readFile(join(import.meta.dirname, "../../test/fixtures/demo-pr3/comments.json"), "utf8"),
    ) as BacklogComment[];
    const { threads, roles, warnings } = buildThreads(comments, { myselfId: 1001 });
    // 8 件のうち、表示確認用のサンプル（#5725744, root=0）以外の 7 件が指摘になる
    assert.equal(threads.length, 7);
    assert.equal(roles.get(5725744), "ignored");
    assert.equal(warnings.length, 1);
  });
});
