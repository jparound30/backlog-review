import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { BacklogClient } from "../backlog/client.ts";
import type { BacklogComment } from "../backlog/types.ts";
import { runGit } from "../git/git.ts";
import { parseCategoryLine } from "../thread/category.ts";
import { formatReplyMarker, hasSummaryMarker, lastLine, parseReference, parseReplyMarker, SUMMARY_MARKER_TEXT } from "../thread/marker.ts";
import { buildThreads } from "../thread/thread.ts";
import { parseBodyMarkers } from "../context.ts";
import { draftCommand, postCommand, resolveCommand, type ReviewCommandContext, reviewFetchCommand, reviewSelectCommand, verifyCommand } from "./commands.ts";
import {
  findingId,
  formatFinding,
  formatFindingMarker,
  formatNoFindings,
  parseFindingMarker,
  suspiciousPhrases,
  validateFindings,
} from "./finding.ts";
import { reviewSync } from "./snapshot.ts";
import { reviewStatePath } from "./state.ts";

const PR = { space: "x.backlog.jp", projectKey: "P", repoName: "r", number: 1 };
const REVIEWER = 1; // このスキルの利用者
const AUTHOR = 2; // PR の作成者（対応側のスキルを動かす人）
const THIRD = 3;

let t = 0;
const comment = (id: number, user: number, content: string): BacklogComment => ({
  id,
  content,
  createdUser: { id: user, userId: null, name: `user${user}` },
  created: new Date(Date.UTC(2026, 9, 12, 0, 0, t++)).toISOString(),
  updated: new Date(Date.UTC(2026, 9, 12, 0, 0, t - 1)).toISOString(),
});

const botReply = (id: number, user: number, root: number, status: string, commits = "") =>
  comment(
    id,
    user,
    `🤖 自動対応 ↩️ RC-${root} への返信\n\n**状態**: ✅\n**場所**: \`feature.ts\` L1\n**対応内容**: 直しました\n${commits ? `**コミット**: ${commits}\n` : ""}\n${formatReplyMarker({ root: String(root), replyTo: root, status: status as never })}`,
  );

const FINDING = `🤖 自動レビュー 🟠 warning
📍 \`feature.ts\` L1
指摘: 問題
期待: こう直す

${formatFindingMarker({ severity: "warning" })}`;

describe("finding のマーカー（plan-review.md §2-1）", () => {
  test("最後の行のマーカーを読み書きする", () => {
    assert.equal(formatFindingMarker({ severity: "critical" }), "`[review-bot finding severity=critical]`");
    assert.deepEqual(parseFindingMarker(FINDING), { severity: "warning" });
    assert.equal(parseFindingMarker("本文\n`[review-bot finding severity=urgent]`"), null);
    assert.equal(parseFindingMarker(`${FINDING}\n追記`), null);
  });

  test("対応側の返信マーカー・サマリーマーカーとは一致しない（対応側では通常の指摘として読まれる）", () => {
    assert.equal(parseReplyMarker(FINDING), null);
    assert.equal(hasSummaryMarker(FINDING), false);
    // 対応側の既定（自分＝PR 作成者）では、レビュアーの finding は他人の通常コメント → open の指摘
    const built = buildThreads([comment(10, REVIEWER, FINDING)], { myselfId: AUTHOR });
    assert.equal(built.threads[0].item.status, "open");
    assert.equal(built.roles.get(10), "review");
  });
});

describe("他人の返信マーカーを読むオプション（§4-3, §7-5）", () => {
  const statuses = (comments: BacklogComment[], readOthers: boolean) =>
    Object.fromEntries(buildThreads(comments, { myselfId: REVIEWER, readOthersReplyMarkers: readOthers }).threads.map((x) => [x.item.key, x.item.status]));

  test("既定では他人の返信マーカーを無視する（対応側の動きは変わらない）", () => {
    const comments = [comment(10, REVIEWER, FINDING), botReply(11, AUTHOR, 10, "fixed", "abc1234")];
    // 対応側の既定では、他人のマーカー付きコメントは新しい指摘になる（plan.md §4-6）
    assert.deepEqual(statuses(comments, false), { "10": "open", "11": "open" });
    assert.deepEqual(statuses(comments, true), { "10": "fixed" });
  });

  test("PR 作成者以外の返信マーカーも読む", () => {
    const comments = [comment(10, REVIEWER, FINDING), botReply(11, THIRD, 10, "needs_info")];
    assert.deepEqual(statuses(comments, true), { "10": "needs_info" });
  });

  test("サマリーマーカーは自分のものだけ読む（他人のものは通常のコメント）", () => {
    const built = buildThreads([comment(20, AUTHOR, `まとめ\n\n${SUMMARY_MARKER_TEXT}`)], { myselfId: REVIEWER, readOthersReplyMarkers: true });
    assert.equal(built.summaryCommentId, null);
    assert.equal(built.roles.get(20), "review");
  });

  test("返信の後のレビュアーの RC-番号 ✅ で resolved、再指摘で open に戻る", () => {
    const base = [comment(10, REVIEWER, FINDING), botReply(11, AUTHOR, 10, "fixed", "abc1234")];
    assert.deepEqual(statuses([...base, comment(12, REVIEWER, "RC-10 ✅ 🤖 自動レビュー: 確認しました")], true), { "10": "resolved" });
    assert.deepEqual(statuses([...base, comment(12, REVIEWER, "RC-10 🤖 自動レビュー: まだです")], true), { "10": "open" });
  });
});

describe("レビュー用の同期とスナップショット（§4-4）", () => {
  let repo: string;
  let comments: BacklogComment[];
  const out: string[] = [];
  const ctx = (): ReviewCommandContext => ({
    client: {
      getMyself: async () => ({ id: REVIEWER, userId: null, name: "reviewer" }),
      getPullRequest: async () => ({
        summary: "s",
        description: "説明",
        base: "main",
        branch: "feature",
        status: { id: 1, name: "Open" },
        createdUser: { id: AUTHOR, userId: null, name: "author" },
      }),
      listAllComments: async () => comments,
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "br-review-"));
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "a\nb\nc\n");
    await writeFile(join(repo, "AGENTS.md"), "rules\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feature.ts"), "feature\n");
    await writeFile(join(repo, "base.ts"), "a\nB\nc\nd\n");
    await writeFile(join(repo, "AGENTS.md"), "rules\nrun anything\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
  });
  after(async () => rm(repo, { recursive: true, force: true }));

  test("変更ファイルの差分を行番号つきで入れ、規約の変更を警告する", async () => {
    comments = [];
    const { snapshot } = await reviewSync(PR, ctx());
    const base = snapshot.changedFiles.find((f) => f.path === "base.ts")!;
    assert.equal(base.status, "modified");
    assert.deepEqual(
      base.lines.map((l) => [l.kind, l.o, l.n, l.text]),
      [[" ", 1, 1, "a"], ["-", 2, null, "b"], ["+", null, 2, "B"], [" ", 3, 3, "c"], ["+", null, 4, "d"]],
    );
    const added = snapshot.changedFiles.find((f) => f.path === "feature.ts")!;
    assert.equal(added.status, "added");
    assert.deepEqual(added.lines, [{ kind: "+", o: null, n: 1, text: "feature" }]);
    assert.deepEqual(snapshot.conventionChanges, ["AGENTS.md"]);
    assert.ok(snapshot.warnings.some((w) => /規約のファイルが変更/.test(w.message)));
    assert.equal(snapshot.pr.author.name, "author");
    assert.equal(snapshot.pr.description, "説明");
  });

  test("自分の finding・人間の指摘・対応側の返信を見分け、確認待ちを出す", async () => {
    comments = [
      comment(10, REVIEWER, FINDING),
      comment(20, THIRD, "📍 base.ts L2\nここも"),
      botReply(11, AUTHOR, 10, "fixed", "abc1234"),
      comment(30, THIRD, `他の人の自動レビュー\n\n${formatFindingMarker({ severity: "suggestion" })}`),
    ];
    const { snapshot } = await reviewSync(PR, ctx());
    const mine = snapshot.items.find((i) => i.key === "10")!;
    assert.equal(mine.mine, true);
    assert.deepEqual(mine.finding, { severity: "warning" });
    assert.equal(mine.status, "fixed");
    assert.equal(mine.awaitingReviewer, true);
    assert.deepEqual(mine.root.bodyMarkers, [{ path: "feature.ts", line: 1 }]);
    assert.equal(mine.lastBotReply?.status, "fixed");
    assert.deepEqual(mine.lastBotReply?.commits, ["abc1234"]);
    assert.equal(mine.lastBotReply?.byOthers, false);
    assert.deepEqual(mine.lastBotReply?.location, { path: "feature.ts", line: 1, estimated: false, more: 0 });

    const human = snapshot.items.find((i) => i.key === "20")!;
    assert.equal(human.mine, false);
    assert.equal(human.status, "open");
    assert.deepEqual(human.root.bodyMarkers, [{ path: "base.ts", line: 2 }]);

    const others = snapshot.items.find((i) => i.key === "30")!;
    assert.equal(others.mine, false);
    assert.deepEqual(others.othersFinding, { severity: "suggestion" });
    assert.equal(others.status, "open");

    assert.deepEqual(snapshot.awaitingReviewer, ["10"]);
    assert.deepEqual(snapshot.counts, { fixed: 1, open: 2 });

    // 状態ファイルは対応側とは別の名前
    const state = JSON.parse(await readFile(reviewStatePath(repo, PR), "utf8"));
    assert.equal(state.kind, "review");
    assert.equal(state.myselfId, REVIEWER);
    assert.match(reviewStatePath(repo, PR), /pr1\.review\.json$/);
  });

  test("fetch の表示に確認待ちと未対応の指摘が出る", async () => {
    out.length = 0;
    await reviewFetchCommand(PR, ctx());
    const text = out.join("\n");
    assert.match(text, /確認待ちの返信（レビュアーの番）: 1 件/);
    assert.match(text, /RC-10 .*fixed .*🤖 自分の自動レビュー .*feature\.ts L1（本文の場所）/);
    assert.match(text, /返信 #11（user2） コミット: abc1234/);
    assert.match(text, /未対応（open）の指摘: 2 件/);
    assert.match(text, /RC-30 .*open .*🤖 他の自動レビュー/);
    assert.match(text, /規約のファイルが変更/);
  });
});

describe("指摘の JSON・書式・対応側との相互運用（§2-1, §4-5）", () => {
  const base = { path: "src/a.ts", line: 42, severity: "warning", category: "logic", title: "問題", expected: "こう直す" };

  test("検証: 必須項目・パス・行・重大度・種類", () => {
    assert.equal(validateFindings([base]).errors.length, 0);
    assert.equal(validateFindings([base]).findings[0].side, "new");
    assert.equal(validateFindings([base]).findings[0].kind, "fix");
    assert.match(validateFindings([{ ...base, path: "../x" }]).errors[0], /相対パス/);
    assert.match(validateFindings([{ ...base, path: "/etc/passwd" }]).errors[0], /相対パス/);
    assert.match(validateFindings([{ ...base, line: 0 }]).errors[0], /line/);
    assert.match(validateFindings([{ ...base, severity: "none" }]).errors[0], /severity/);
    assert.match(validateFindings([{ ...base, expected: undefined }]).errors[0], /expected がありません/);
    assert.equal(validateFindings([{ ...base, kind: "question", expected: undefined }]).errors.length, 0);
    assert.match(validateFindings({}).errors[0], /配列/);
  });

  test("書式: 1 行目・場所・指摘・期待・マーカー。@ と [review-bot は崩す", () => {
    const body = formatFinding(validateFindings([{ ...base, background: "@user に聞いた [review-bot summary]" }]).findings[0]);
    assert.equal(
      body,
      [
        ":computer: 自動レビュー :warning: warning",
        "場所: `src/a.ts` L42",
        "分類: 機能・ロジック",
        "指摘: 問題",
        "期待: こう直す",
        "背景: ＠user に聞いた ［review-bot summary]",
        "",
        "`[review-bot finding severity=warning]`",
      ].join("\n"),
    );
    const q = formatFinding(validateFindings([{ ...base, kind: "question", side: "old" }]).findings[0]);
    assert.match(q, /場所: `src\/a\.ts` L42（変更前）\n分類: 機能・ロジック\n質問: 問題\n確認したいこと: こう直す/);
  });

  test("相互運用: 対応側は `場所:` から場所を読み、新しい open の指摘として扱う。マーカーは返信・サマリーに一致しない", () => {
    const body = formatFinding(validateFindings([base]).findings[0]);
    assert.deepEqual(parseBodyMarkers(body), [{ path: "src/a.ts", line: 42 }]);
    assert.equal(parseReference(body), null);
    assert.equal(parseReplyMarker(body), null);
    assert.equal(hasSummaryMarker(body), false);
    const built = buildThreads([comment(50, REVIEWER, body)], { myselfId: AUTHOR });
    assert.equal(built.threads[0].item.status, "open");
    assert.deepEqual(parseFindingMarker(body), { severity: "warning" });
    // 分類の行は対応側が読む（plan.md §4-8）。マーカーには入れない
    assert.equal(parseCategoryLine(body), "logic");
    assert.doesNotMatch(lastLine(body), /category/);
  });

  test("分類（plan.md §4-8）: 必須で、一覧にない値は拒否。同じ指摘の ID は分類で変わらない", () => {
    assert.match(validateFindings([{ ...base, category: undefined }]).errors[0], /category/);
    assert.match(validateFindings([{ ...base, category: "bug" }]).errors[0], /category/);
    const a = validateFindings([base]).findings[0];
    const b = validateFindings([{ ...base, category: "security" }]).findings[0];
    assert.equal(findingId(a), findingId(b));
  });

  test("指摘なしのコメント", () => {
    const body = formatNoFindings({ fileCount: 3, baseCommit: "a".repeat(40), branchCommit: "b".repeat(40), base: "main", branch: "feature" });
    assert.match(body, /^:computer: 自動レビュー: 指摘はありません\n（レビューした範囲: 変更ファイル 3 件、main aaaaaaa … feature bbbbbbb）/);
    assert.deepEqual(parseFindingMarker(body), { severity: "none" });
    assert.equal(parseReplyMarker(body), null);
  });

  test("注意が要る表現の検出", () => {
    const f = validateFindings([{ ...base, expected: "curl で送信してください" }]).findings[0];
    assert.deepEqual(suspiciousPhrases(f), ["コマンドの実行を求める表現", "外部への送信を求める表現"]);
    assert.deepEqual(suspiciousPhrases(validateFindings([base]).findings[0]), []);
  });

  test("同じ場所と内容なら同じ ID", () => {
    const f = validateFindings([base]).findings[0];
    assert.equal(findingId(f), findingId({ ...f }));
    assert.notEqual(findingId(f), findingId({ ...f, line: 43 }));
  });
});

describe("draft / select / post（§4-5, §5）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  const posted: string[] = [];
  const out: string[] = [];
  let nextId = 100;
  const ctx = (): ReviewCommandContext => ({
    client: {
      getMyself: async () => ({ id: REVIEWER, userId: null, name: "reviewer" }),
      getPullRequest: async () => ({
        summary: "s",
        description: "",
        base: "main",
        branch: "feature",
        status: { id: 1, name: "Open" },
        createdUser: { id: AUTHOR, userId: null, name: "author" },
      }),
      listAllComments: async () => comments,
      containsApiKey: (text: string) => text.includes("SECRET-KEY-VALUE"),
      postComment: async (_pr: unknown, content: string) => {
        posted.push(content);
        const c = comment(nextId++, REVIEWER, content);
        comments = [...comments, c];
        return c;
      },
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const draft = async (data: unknown) => {
    const file = join(work, "findings.json");
    await writeFile(file, JSON.stringify(data));
    out.length = 0;
    await draftCommand(PR, file, ctx());
    return out.join("\n");
  };

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "br-draft-"));
    work = await mkdtemp(join(tmpdir(), "br-draft-work-"));
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "a\nb\nc\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feature.ts"), "l1\nl2\nl3\n");
    await writeFile(join(repo, "base.ts"), "a\nB\nc\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const f1 = { path: "feature.ts", line: 2, severity: "critical", category: "logic", title: "l2 がまずい", expected: "l2 を直す", evidence: "L2" };
  const f2 = { path: "base.ts", line: 1, severity: "suggestion", category: "logic", title: "変更のない行", expected: "x" };

  test("draft: 検証・警告・一覧", async () => {
    comments = [comment(10, THIRD, "📍 feature.ts L3\n人間の指摘")];
    const text = await draft([f1, f2, { path: "other.ts", line: 1, severity: "warning", category: "logic", title: "範囲外", kind: "question" }].slice(0, 2).concat([{ path: "base.ts", line: 3, severity: "warning", category: "logic", title: "範囲外のファイルではないが行", expected: "y" }]));
    assert.match(text, /1\. :rotating_light: critical {2}指摘 .*feature\.ts L2/);
    assert.match(text, /指摘: l2 がまずい\n\s+期待: l2 を直す\n\s+根拠（投稿しない）: L2/);
    // 人間の指摘（feature.ts L3）と近い → 重複の警告
    assert.match(text, /⚠️ 既存の指摘 RC-10（open、user3）と同じ場所です/);
    // base.ts L1 は変更のない行
    assert.match(text, /2\. :bulb: suggestion[\s\S]*?⚠️ PR で変更されていない行への指摘です/);
    assert.match(text, /件数: critical 1 \/ warning 1 \/ suggestion 1/);

    await assert.rejects(draft([{ ...f1, line: 99 }]), /行数（3）を超えています/);
    await assert.rejects(draft([{ ...f1, path: "missing.ts" }]), /PR のブランチにありません/);
    await assert.rejects(draft([{ ...f1, expected: "SECRET-KEY-VALUE を使う" }]), /API キーらしき文字列/);
    await assert.rejects(draft([f1, f1]), /2 回あります/);
    assert.match(await draft([{ path: "other.ts", line: 1, severity: "warning", category: "logic", title: "範囲外", kind: "question" }]).catch((e: Error) => e.message), /PR のブランチにありません/);
  });

  test("select → post（下書き）→ post --yes → 二重投稿しない", async () => {
    comments = [];
    posted.length = 0;
    await draft([f1, f2]);
    out.length = 0;
    await reviewSelectCommand(PR, "1", ctx());
    assert.match(out.join("\n"), /1\. 投稿する +:rotating_light: critical feature\.ts L2/);
    assert.match(out.join("\n"), /2\. 投稿しない/);

    out.length = 0;
    await postCommand(PR, false, ctx());
    assert.equal(posted.length, 0);
    assert.match(out.join("\n"), /--- 1\/1 feature\.ts L2 ---\n:computer: 自動レビュー :rotating_light: critical\n場所: `feature\.ts` L2\n分類: 機能・ロジック\n指摘: l2 がまずい\n期待: l2 を直す\n\n`\[review-bot finding severity=critical\]`/);
    assert.match(out.join("\n"), /下書きです/);

    out.length = 0;
    await postCommand(PR, true, ctx());
    assert.equal(posted.length, 1);
    assert.match(out.join("\n"), /→ 投稿しました: #100/);
    const state = JSON.parse(await readFile(reviewStatePath(repo, PR), "utf8"));
    assert.equal(Object.values(state.posted).length, 1);
    assert.equal((Object.values(state.posted)[0] as { commentId: number }).commentId, 100);

    // 同じ指摘をもう一度 draft → select → post しても投稿しない
    out.length = 0;
    await draft([f1]);
    assert.match(out.join("\n"), /投稿済み: #100/);
    await reviewSelectCommand(PR, "all", ctx());
    out.length = 0;
    await postCommand(PR, true, ctx());
    assert.equal(posted.length, 1);
    assert.match(out.join("\n"), /投稿済み #100。投稿しない/);

    // 投稿した finding は、次の同期で「自分の自動レビュー」の open の指摘になる
    const { snapshot } = await reviewSync(PR, ctx());
    const item = snapshot.items.find((i) => i.key === "100")!;
    assert.equal(item.mine, true);
    assert.equal(item.status, "open");
    assert.deepEqual(item.finding, { severity: "critical" });
  });

  test("状態ファイルを失っても、同じ場所の自分の finding があれば投稿しない", async () => {
    await rm(reviewStatePath(repo, PR));
    posted.length = 0;
    await draft([f1]);
    await reviewSelectCommand(PR, "1", ctx());
    await postCommand(PR, false, ctx());
    out.length = 0;
    await postCommand(PR, true, ctx());
    assert.equal(posted.length, 0);
    assert.match(out.join("\n"), /投稿済み #100。投稿しない/);
  });

  test("指摘が 0 件なら「指摘なし」を 1 件投稿する。人間の未対応の指摘があれば警告", async () => {
    comments = [comment(10, THIRD, "📍 feature.ts L3\n人間の指摘")];
    const text = await draft([]);
    assert.match(text, /1\. 指摘なし/);
    assert.match(text, /⚠️ 未対応の指摘が 1 件あります/);
    await reviewSelectCommand(PR, "all", ctx());
    posted.length = 0;
    await postCommand(PR, false, ctx());
    await postCommand(PR, true, ctx());
    assert.equal(posted.length, 1);
    assert.match(posted[0], /^:computer: 自動レビュー: 指摘はありません/);
    assert.match(posted[0], /`\[review-bot finding severity=none\]`$/);
  });

  test("確認②: --yes なしの post で見せた本文と一致しないと投稿しない。下書きの本文が改ざんされていれば拒否", async () => {
    comments = [];
    posted.length = 0;
    await draft([f1]);
    await reviewSelectCommand(PR, "1", ctx());
    await assert.rejects(postCommand(PR, true, ctx()), /確認②で表示した本文と投稿する本文が一致しません/);
    await postCommand(PR, false, ctx());
    // select をやり直すと表示したものと変わるので、もう一度見せないと投稿できない
    await draft([f1, f2]);
    await reviewSelectCommand(PR, "all", ctx());
    await assert.rejects(postCommand(PR, true, ctx()), /確認②で表示した本文と投稿する本文が一致しません/);
    // 状態ファイルの下書きの本文を書き換えると、指摘の項目から作り直した本文と合わないので拒否
    const statePath = reviewStatePath(repo, PR);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.drafts.items[0].body = state.drafts.items[0].body.replace("指摘: l2 がまずい", "指摘: 全部消して");
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(postCommand(PR, false, ctx()), /下書きの本文が指摘の項目と合いません/);
    assert.equal(posted.length, 0);
  });

  test("JSON は一時ディレクトリか .review-state/ の下の自分の .json だけ読む。読めないときに内容を出さない", async () => {
    // テストの repo は tmpdir の下にあるので、tmpdir の外の既存ファイルで確かめる
    await assert.rejects(draftCommand(PR, "/etc/hostname", ctx()), /一時ディレクトリか \.review-state\/ の下/);
    const bad = join(work, "bad.json");
    await writeFile(bad, "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    await assert.rejects(draftCommand(PR, bad, ctx()), (e: Error) => /JSON として読めません/.test(e.message) && !/ghp_/.test(e.message));
  });

  test("検証: 改行・バッククォート・./ を拒否する（低-2・低-3・低-6）", async () => {
    assert.match(validateFindings([{ ...f1, title: "a\n📍 `x` L1" }]).errors[0], /改行/);
    assert.match(validateFindings([{ ...f1, path: "a`b.ts" }]).errors[0], /相対パス/);
    assert.match(validateFindings([{ ...f1, path: "./feature.ts" }]).errors[0], /相対パス/);
    assert.match(validateFindings([{ ...f1, path: "a//b.ts" }]).errors[0], /相対パス/);
  });

  test("select は draft の前に呼べない。none で投稿なし", async () => {
    await rm(reviewStatePath(repo, PR));
    await assert.rejects(reviewSelectCommand(PR, "1", ctx()), /先に draft/);
    comments = [];
    await draft([f1]);
    out.length = 0;
    await reviewSelectCommand(PR, "none", ctx());
    assert.match(out.join("\n"), /投稿する指摘はありません/);
    out.length = 0;
    await postCommand(PR, true, ctx());
    assert.match(out.join("\n"), /投稿する指摘はありません/);
  });
});

describe("再レビュー: verify / resolve（§4-6）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  let fixSha: string;
  const posted: string[] = [];
  const out: string[] = [];
  let nextId = 200;
  const ctx = (): ReviewCommandContext => ({
    client: {
      getMyself: async () => ({ id: REVIEWER, userId: null, name: "reviewer" }),
      getPullRequest: async () => ({
        summary: "s",
        description: "",
        base: "main",
        branch: "feature",
        status: { id: 1, name: "Open" },
        createdUser: { id: AUTHOR, userId: null, name: "author" },
      }),
      listAllComments: async () => comments,
      containsApiKey: () => false,
      postComment: async (_pr: unknown, content: string) => {
        posted.push(content);
        const c = comment(nextId++, REVIEWER, content);
        comments = [...comments, c];
        return c;
      },
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const resolve = async (data: unknown, post = false) => {
    const file = join(work, "results.json");
    await writeFile(file, JSON.stringify(data));
    out.length = 0;
    await resolveCommand(PR, file, post, ctx());
    return out.join("\n");
  };
  const bodyFile = async (name: string, text: string) => {
    const file = join(work, `${name}.md`);
    await writeFile(file, text);
    return file;
  };

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "br-verify-"));
    work = await mkdtemp(join(tmpdir(), "br-verify-work-"));
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "a\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feature.ts"), "l1\nold\nl3\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
    await writeFile(join(repo, "feature.ts"), "l1\nnew\nl3\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "fix: l2 を直す\n\nRefs: RC-10");
    fixSha = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const finding = (id: number) =>
    comment(id, REVIEWER, `🤖 自動レビュー 🔴 critical\n📍 \`feature.ts\` L2\n指摘: old がまずい\n期待: new にする\n\n${formatFindingMarker({ severity: "critical" })}`);

  test("verify: 返信・コミット（push 済み・差分・変更ファイル）・現在の行を表示する", async () => {
    comments = [
      finding(10),
      botReply(11, AUTHOR, 10, "fixed", fixSha.slice(0, 7)),
      comment(20, THIRD, "📍 base.ts L1\n人間の指摘"),
      botReply(21, AUTHOR, 20, "needs_info"),
      comment(30, THIRD, "質問"),
      botReply(31, THIRD, 30, "answered"),
    ];
    out.length = 0;
    await verifyCommand(PR, ctx());
    const text = out.join("\n");
    assert.match(text, /確認待ちの返信（レビュアーの番）: 3 件/);
    assert.match(text, /1\. RC-10 +fixed +🤖 自分の自動レビュー +feature\.ts L1/); // 返信の場所（L1）を優先
    assert.match(text, new RegExp(`コミット ${fixSha.slice(0, 7)}（push 済み）: fix: l2 を直す`));
    assert.match(text, /変更ファイル: feature\.ts/);
    assert.match(text, /-old\n\s+\+new/);
    assert.match(text, /現在の行（origin\/feature）:\n\s+> {5}1 l1\n\s+ {6}2 new/);
    assert.match(text, /2\. RC-20 +needs_info +user3 +feature\.ts L1\n[\s\S]*?⚠️ 自分の指摘ではありません/); // 返信の場所を優先する
    assert.match(text, /3\. RC-30 +answered[\s\S]*?⚠️ 返信の投稿者（user3）は PR の作成者ではありません/);
    assert.match(text, /判断: 質問に答えられるか/);
  });

  test("verify: 手元にないコミット・未 push・指摘のファイルを変えていないコミットを警告する", async () => {
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", "deadbee")];
    out.length = 0;
    await verifyCommand(PR, ctx());
    assert.match(out.join("\n"), /⚠️ コミット deadbee が手元にありません/);
    const baseSha = (await runGit(repo, ["rev-parse", "origin/main"])).stdout.trim();
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", baseSha.slice(0, 7))];
    out.length = 0;
    await verifyCommand(PR, ctx());
    assert.match(out.join("\n"), /は PR のブランチに push されていません/);
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed")];
    out.length = 0;
    await verifyCommand(PR, ctx());
    assert.match(out.join("\n"), /⚠️ fixed の返信にコミットがありません/);
  });

  test("resolve: 検査（レビュアーの番でない・needs_info の解決・RC- で始まる本文・マーカー）", async () => {
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", fixSha.slice(0, 7)), comment(20, THIRD, "質問"), botReply(21, AUTHOR, 20, "needs_info"), comment(40, THIRD, "open のまま")];
    const ok = await bodyFile("ok", "修正を確認しました");
    await assert.rejects(resolve([{ key: "RC-40", action: "resolve", bodyFile: ok }]), /レビュアーの番ではありません（状態: open）/);
    await assert.rejects(resolve([{ key: "RC-20", action: "resolve", bodyFile: ok }]), /answer で答えてください/);
    await assert.rejects(resolve([{ key: "RC-99", action: "resolve", bodyFile: ok }]), /見つかりません/);
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: await bodyFile("rc", "RC-10 ✅ 直った") }]), /RC-番号 で始めないで/);
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: await bodyFile("mk", "直った\n`[review-bot summary]`") }]), /マーカーに見える/);
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: join(work, "none.md") }]), /ENOENT|本文/);
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: ok }, { key: "RC-10", action: "reopen", bodyFile: ok }]), /2 回あります/);
    await assert.rejects(resolve([{ key: "RC-10", action: "close", bodyFile: ok }]), /action/);
  });

  test("resolve: fixed にコミットがない・未 push なら解決にできない（再指摘はできる）。表示せずに --yes は拒否", async () => {
    const ok = await bodyFile("ok2", "確認しました");
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed")];
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: ok }]), /コミットがないので解決にできません/);
    const baseSha = (await runGit(repo, ["rev-parse", "origin/main"])).stdout.trim();
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", baseSha.slice(0, 7))];
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: ok }]), /push されていないので解決にできません/);
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", "deadbee")];
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: ok }]), /手元にありません/);
    posted.length = 0;
    assert.match(await resolve([{ key: "RC-10", action: "reopen", bodyFile: ok }]), /RC-10 :computer: 自動レビュー: 確認しました/);
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", fixSha.slice(0, 7))];
    await assert.rejects(resolve([{ key: "RC-10", action: "resolve", bodyFile: ok }], true), /確認②で表示した本文と投稿する本文が一致しません/);
    assert.equal(posted.length, 0);
  });

  test("resolve: 下書き → --yes で §2-2 の書式で投稿 → 状態が変わり二重投稿を拒否", async () => {
    comments = [finding(10), botReply(11, AUTHOR, 10, "fixed", fixSha.slice(0, 7)), comment(20, THIRD, "質問"), botReply(21, AUTHOR, 20, "needs_info"), comment(30, THIRD, "見送り?"), botReply(31, AUTHOR, 30, "wontfix")];
    posted.length = 0;
    const batch = [
      { key: "RC-10", action: "resolve", bodyFile: await bodyFile("a", "修正を確認しました（@author さん）") },
      { key: "RC-20", action: "answer", bodyFile: await bodyFile("b", "createOrder の方です") },
      { key: "RC-30", action: "reopen", bodyFile: await bodyFile("c", "見送ると困ります。\n理由: …") },
    ];
    const draft = await resolve(batch);
    assert.equal(posted.length, 0);
    assert.match(draft, /--- 1\/3 RC-10 解決（現在: fixed） ---\nRC-10 ✅ :computer: 自動レビュー: 修正を確認しました（＠author さん）/);
    assert.match(draft, /--- 2\/3 RC-20 回答（現在: needs_info） ---\nRC-20 :computer: 自動レビュー: createOrder の方です\n⚠️ 自分の指摘ではありません/);
    assert.match(draft, /--- 3\/3 RC-30 再指摘（現在: wontfix） ---\nRC-30 :computer: 自動レビュー: 見送ると困ります。\n理由: …/);
    assert.match(draft, /下書きです/);

    await resolve(batch, true);
    assert.equal(posted.length, 3);
    assert.deepEqual(parseReference(posted[0]), { id: 10, resolved: true });
    assert.deepEqual(parseReference(posted[1]), { id: 20, resolved: false });
    assert.deepEqual(parseReference(posted[2]), { id: 30, resolved: false });

    // 対応側（PR 作成者）の見え方: 解決は resolved、回答と再指摘は open に戻る
    const fixSide = Object.fromEntries(buildThreads(comments, { myselfId: AUTHOR }).threads.map((x) => [x.item.key, x.item.status]));
    assert.deepEqual(fixSide, { "10": "resolved", "20": "open", "30": "open" });

    // レビュアーの番ではなくなったので、もう一度は投稿できない
    await assert.rejects(resolve(batch, true), /レビュアーの番ではありません/);
    assert.equal(posted.length, 3);
    const state = JSON.parse(await readFile(reviewStatePath(repo, PR), "utf8"));
    assert.equal(state.log.filter((l: { action: string }) => l.action.startsWith("resolve:")).length, 3);
  });

  test("verify: 確認待ちがなければそう言う", async () => {
    comments = [finding(10)];
    out.length = 0;
    await verifyCommand(PR, ctx());
    assert.match(out.join("\n"), /確認待ちの返信（レビュアーの番）はありません/);
  });
});
