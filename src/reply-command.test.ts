import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { BacklogClient } from "./backlog/client.ts";
import type { BacklogComment } from "./backlog/types.ts";
import {
  type CommandContext,
  commitCommand,
  fetchCommand,
  interpretCommand,
  parseChoice,
  replyBatchCommand,
  replyCommand,
  selectCommand,
  summaryCommand,
} from "./commands.ts";
import { formatReply } from "./reply/format.ts";
import { runGit } from "./git/git.ts";
import { formatReplyMarker } from "./thread/marker.ts";

const PR = { space: "x.backlog.jp", projectKey: "P", repoName: "r", number: 1 };
const ME = 1;
const OTHER = 2;

const comment = (id: number, user: number, content: string): BacklogComment => ({
  id,
  content,
  createdUser: { id: user, userId: null, name: `user${user}` },
  created: "2026-10-12T00:00:00Z",
  updated: "2026-10-12T00:00:00Z",
});

const point = (kind: string, intent = "clear", summary?: string) => ({
  ...(summary ? { summary } : {}),
  kind,
  location: { judgment: "explicit", path: "feature.ts", line: 1, reason: "本文に明記" },
  intent: { judgment: intent, reason: "r" },
  scope: { judgment: "local", reason: "r" },
  plan: "p",
});

describe("論点の組み合わせによる返信の制限と、分割しない指摘（§7-8）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  const out: string[] = [];
  const ctx = (): CommandContext => ({
    client: {
      getMyself: async () => ({ id: ME, userId: null, name: "me" }),
      getPullRequest: async () => ({ summary: "s", base: "main", branch: "feature", status: { id: 1, name: "Open" } }),
      listAllComments: async () => comments,
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const interpret = async (data: unknown) => {
    const file = join(work, "interp.json");
    await writeFile(file, JSON.stringify(data));
    await interpretCommand(PR, file, ctx());
  };
  const reply = async (key: string, status: string, commits: string[] = []) => {
    const body = join(work, "body.md");
    await writeFile(body, "本文");
    out.length = 0;
    await replyCommand(PR, { key, status, bodyFile: body, commits, post: false }, ctx());
    return out.join("\n");
  };

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-reply-"));
    work = await mkdtemp(join(tmpdir(), "bfr-reply-work-"));
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
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("直し方の決まらない論点があれば needs_info だけを許し、コミットも付けさせない", async () => {
    comments = [comment(10, OTHER, "1. 名前を data に\n2. もう少し良くして")];
    await interpret([{ key: "RC-10", points: [point("fix", "clear", "名前"), point("fix", "ambiguous", "改善")] }]);
    assert.match(out.join("\n"), /論点 2 件 .*返信: needs_info {2}ランク: low/);
    assert.match(out.join("\n"), /直し方が決まっている論点は、回答の後にまとめて直す/);

    await assert.rejects(reply("RC-10", "fixed", ["abcdef0"]), /needs_info です/);
    await assert.rejects(reply("RC-10", "needs_info", ["abcdef0"]), /コミットを付けられるのは fixed/);
    assert.match(await reply("RC-10", "needs_info"), /自動で修正しなかった理由\*\*: 論点 2: 直し方が 1 通りに決まらない/);
  });

  test("解釈のない指摘には返信しない", async () => {
    comments = [comment(20, OTHER, "質問です")];
    await assert.rejects(reply("RC-20", "answered"), /まだ解釈されていません/);
  });

  test("分割した key は受け付けない", async () => {
    comments = [comment(30, OTHER, "指摘")];
    await assert.rejects(interpret([{ key: "RC-30#1", points: [point("fix")] }]), /分割しません/);
  });

  test("状態ファイルが消えても、以前に分割して返信した指摘は一覧から消えない（R-2）", async () => {
    comments = [
      comment(40, OTHER, "1. 命名\n2. 例外処理"),
      comment(41, ME, `🤖 自動対応\n\n${formatReplyMarker({ root: "40#1" as string, replyTo: 40, status: "fixed" })}`),
    ];
    await rm(join(repo, ".review-state"), { recursive: true, force: true });
    out.length = 0;
    const snapshot = await fetchCommand(PR, ctx(), true);
    assert.deepEqual(
      snapshot.items.map((i) => [i.key, i.status]),
      [["40", "fixed"]],
    );
    comments.push(comment(42, OTHER, "RC-40#2 例外処理がまだです"));
    const reopened = await fetchCommand(PR, ctx(), true);
    assert.deepEqual(
      reopened.items.map((i) => [i.key, i.status]),
      [["40", "open"]],
    );
  });
  test("回答を受けた指摘には、前回の質問を含む会話の履歴が入る。状態ファイルがなくても同じ（R-7）", async () => {
    const question = `🤖 自動対応 ↩️ RC-50 への返信\n**確認したいこと**: createOrder と updateOrder のどちらですか？\n\n${formatReplyMarker({ root: "50", replyTo: 50, status: "needs_info" })}`;
    comments = [comment(50, OTHER, "例外を握りつぶしている"), comment(51, ME, question), comment(52, OTHER, "RC-50 createOrder の方です")];

    const history = async () => {
      out.length = 0;
      const item = (await fetchCommand(PR, ctx())).items.find((i) => i.key === "50")!;
      return { item, entries: item.history.map((h) => [h.id, h.role, h.status ?? null]) };
    };
    const expected = [
      [50, "review", null],
      [51, "bot_reply", "needs_info"],
      [52, "follow_up", null],
    ];
    const first = await history();
    assert.deepEqual(first.entries, expected);
    assert.match(first.item.history[1].content, /createOrder と updateOrder のどちら/);
    assert.match(out.join("\n"), /前回の返信: needs_info #51/);

    await rm(join(repo, ".review-state"), { recursive: true, force: true });
    const again = await history();
    assert.deepEqual(again.entries, expected);
    assert.equal(again.item.previousInterpretation, null);
  });

  test("状態ファイルがなくても、サマリーの場所とコミットを自動返信から読み戻す（R-14）", async () => {
    const replied = formatReply({
      key: "70",
      replyTo: 71,
      reviewerName: "user2",
      quoteSource: "RC-70 📍 feature.ts L1 を直して",
      status: "fixed",
      location: { path: "feature.ts", line: 1, estimated: true },
      body: "直しました",
      commits: ["abcdef0123456789abcdef0123456789abcdef01"],
    });
    comments = [comment(70, OTHER, "もう少しわかりやすく"), comment(71, OTHER, "RC-70 📍 feature.ts L1 を直して"), comment(72, ME, replied)];
    await rm(join(repo, ".review-state"), { recursive: true, force: true });
    out.length = 0;
    const item = (await fetchCommand(PR, ctx(), true)).items.find((i) => i.key === "70")!;
    assert.deepEqual(item.commits, ["abcdef0"]);
    out.length = 0;
    await summaryCommand(PR, false, ctx());
    assert.match(out.join("\n"), /\| ✅ fixed \| `feature\.ts` L1（推定） \| abcdef0 \|/);
  });

  test("期限切れの前回の解釈は、同じ環境に残っていれば参考として添える", async () => {
    comments = [comment(60, OTHER, "1. 名前を data に\n2. もう少し良くして")];
    await interpret([{ key: "RC-60", points: [point("fix", "clear", "名前"), point("fix", "ambiguous", "改善")] }]);
    comments.push(
      comment(61, ME, `🤖 自動対応\n\n${formatReplyMarker({ root: "60", replyTo: 60, status: "needs_info" })}`),
      comment(62, OTHER, "RC-60 2 はログを足す意味です"),
    );
    out.length = 0;
    const item = (await fetchCommand(PR, ctx())).items.find((i) => i.key === "60")!;
    assert.equal(item.status, "open");
    assert.equal(item.interpretation, null);
    assert.equal(item.needsInterpretation, true);
    assert.deepEqual(item.previousInterpretation?.points.map((p) => p.summary), ["名前", "改善"]);
  });
});

describe("判定と修正の裏付けの検査（R-4・R-5）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  const out: string[] = [];
  const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  const ctx = (): CommandContext => ({
    client: {
      getMyself: async () => ({ id: ME, userId: null, name: "me" }),
      getPullRequest: async () => ({ summary: "s", base: "main", branch: "feature", status: { id: 1, name: "Open" } }),
      listAllComments: async () => comments,
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const interpret = async (data: unknown) => {
    const file = join(work, "interp.json");
    await writeFile(file, JSON.stringify(data));
    out.length = 0;
    await interpretCommand(PR, file, ctx());
    return out.join("\n");
  };
  const reply = async (key: string, commits: string[]) => {
    const body = join(work, "body.md");
    await writeFile(body, "直しました");
    out.length = 0;
    await replyCommand(PR, { key, status: "fixed", bodyFile: body, commits, post: false }, ctx());
    return out.join("\n");
  };
  /** feature に push 済みのコミットを作る */
  const pushed = async (path: string, content: string, message: string) => {
    await writeFile(join(repo, path), content);
    await git("add", path);
    await git("commit", "-q", "-m", message);
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    return (await git("rev-parse", "HEAD")).stdout.trim();
  };
  const at = (path: string, line: number) => ({
    kind: "fix",
    location: { judgment: "explicit", path, line, reason: "本文に明記" },
    intent: { judgment: "clear", reason: "r" },
    scope: { judgment: "local", reason: "r" },
    plan: "p",
  });

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-verify-"));
    work = await mkdtemp(join(tmpdir(), "bfr-verify-work-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "base\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await pushed("feature.ts", "line1\nline2\n", "feature");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("行番号がファイルの行数を超えていれば、解釈を受け付けない（R-5）", async () => {
    comments = [comment(80, OTHER, "feature.ts L9 を直して")];
    await assert.rejects(interpret([{ key: "RC-80", points: [at("feature.ts", 9)] }]), /行数（2）を超えています/);
  });

  test("確認①に元のコメントの全文と、変更ファイルにない場所・行コメントとの食い違いを出す（R-5）", async () => {
    const blob = (await git("rev-parse", "origin/feature:feature.ts")).stdout.trim();
    comments = [{ ...comment(81, OTHER, "1 行目の名前を直して\n2 行目もお願いします"), filePath: "feature.ts", position: 1, oldBlobId: null, newBlobId: blob }];
    const text = await interpret([{ key: "RC-81", points: [at("base.ts", 1)] }]);
    assert.match(text, /元のコメント:\n {9}\| 1 行目の名前を直して\n {9}\| 2 行目もお願いします/);
    assert.match(text, /⚠️ 行コメントの場所（feature\.ts）を指す論点がありません/);
    assert.match(text, /⚠️ base\.ts は PR の変更ファイルにありません/);
  });

  test("fixed のコミットには、その指摘の Refs: が必要（R-4）", async () => {
    comments = [comment(90, OTHER, "feature.ts L1 の名前を直して"), comment(91, OTHER, "feature.ts L2 も")];
    await interpret([
      { key: "RC-90", points: [at("feature.ts", 1)] },
      { key: "RC-91", points: [at("feature.ts", 2)] },
    ]);
    const original = (await git("rev-parse", "HEAD")).stdout.trim();
    const for90 = await pushed("feature.ts", "renamed\nline2\n", "fix: 名前を直す\n\nRefs: RC-90");

    assert.match(await reply("RC-90", [for90]), /対応済み/);
    // 別の指摘のコミット、PR の作成者が元から積んでいたコミットは付けられない
    await assert.rejects(reply("RC-91", [for90]), /Refs: RC-91 がありません/);
    await assert.rejects(reply("RC-90", [original]), /Refs: RC-90 がありません/);
  });

  test("指摘の場所のファイルを変えていないコミットには警告を出す（R-4）", async () => {
    const other = await pushed("other.ts", "x\n", "test: テストだけ\n\nRefs: RC-91");
    assert.match(await reply("RC-91", [other]), /⚠️ {2}コミット [0-9a-f]+ は、指摘の場所や仕様書のファイル（feature\.ts）を変更していません/);
  });
});

test("確認①の回答を番号の集合にする（§8 M11）", () => {
  assert.deepEqual([...parseChoice("1,3-5", 5)], [1, 3, 4, 5]);
  assert.deepEqual([...parseChoice(" all ", 3)], [1, 2, 3]);
  assert.deepEqual([...parseChoice("none", 3)], []);
  assert.deepEqual([...parseChoice("１、３－４", 5)], [1, 3, 4]);
  assert.throws(() => parseChoice("6", 5), /1〜5/);
  assert.throws(() => parseChoice("a", 5), /読めません/);
  assert.throws(() => parseChoice("3-1", 5), /逆/);
  assert.throws(() => parseChoice("", 5), /空/);
});

describe("まとめて実行する入口（select・reply --batch, §8 M11）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  const posted: string[] = [];
  const out: string[] = [];
  const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  const ctx = (): CommandContext => ({
    client: {
      getMyself: async () => ({ id: ME, userId: null, name: "me" }),
      getPullRequest: async () => ({ summary: "s", base: "main", branch: "feature", status: { id: 1, name: "Open" } }),
      listAllComments: async () => comments,
      postComment: async (_: unknown, text: string) => {
        posted.push(text);
        const id = 900 + posted.length;
        comments.push(comment(id, ME, text));
        return { id };
      },
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const run = async (f: () => Promise<void>) => {
    out.length = 0;
    await f();
    return out.join("\n");
  };
  const at = (summary?: string, intent = "clear", scope: Record<string, unknown> = { judgment: "local", reason: "r" }, kind = "fix") => ({
    ...(summary ? { summary } : {}),
    kind,
    location: { judgment: "explicit", path: "feature.ts", line: 1, reason: "本文に明記" },
    intent: { judgment: intent, reason: "r" },
    scope,
    plan: "p",
  });
  const docs = { judgment: "local_with_docs", reason: "仕様書も変わる", docs: ["docs/spec.md"] };
  const batch = async (entries: unknown, post = false) => {
    const file = join(work, "batch.json");
    await writeFile(file, JSON.stringify(entries));
    return run(() => replyBatchCommand(PR, file, post, ctx()));
  };
  const body = async (name: string) => {
    const file = join(work, `${name}.md`);
    await writeFile(file, `${name} の本文`);
    return file;
  };
  let fixCommit = "";

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-batch-"));
    work = await mkdtemp(join(tmpdir(), "bfr-batch-work-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "base\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feature.ts"), "line1\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
    await writeFile(join(repo, "feature.ts"), "renamed\n");
    await git("commit", "-q", "-am", "fix: 名前\n\nRefs: RC-10");
    fixCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    comments = [comment(10, OTHER, "feature.ts L1 の名前を直して"), comment(11, OTHER, "もう少し良く"), comment(12, OTHER, "関数名を変えて")];
    const file = join(work, "interp.json");
    await writeFile(
      file,
      JSON.stringify([
        { key: "RC-10", points: [at()] },
        { key: "RC-11", points: [at(undefined, "ambiguous")] },
        { key: "RC-12", points: [at(undefined, "clear", docs)] },
      ]),
    );
    await run(() => interpretCommand(PR, file, ctx()));
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("select は、interpret の一覧の番号で回答を読み、新しいコメントが来てもずれない", async () => {
    comments.push(comment(5, OTHER, "後から来た指摘（id が小さい）"));
    const text = await run(() => selectCommand(PR, "1,2", ctx()));
    assert.match(text, /1\. RC-10 .*選択 +fixed +修正して、1 コミットにし、fixed で返信する/);
    assert.match(text, /2\. RC-11 .*選択 +needs_info +修正せずに、確認の質問を返信する/);
    assert.match(text, /3\. RC-12 .*－ +needs_info +選ばれなかったので、修正せずに確認の質問を返信する/);
    assert.doesNotMatch(text, /RC-5/);
    comments.pop();
    assert.match(await run(() => selectCommand(PR, "3", ctx())), /3\. RC-12 .*選択 +fixed .*docs\/spec\.md/);
  });

  test("reply --batch は下書きを一度に作り、拒否されたものは最後にまとめて示す", async () => {
    await assert.rejects(
      batch([
        { key: "RC-10", status: "fixed", bodyFile: await body("a"), commits: [fixCommit] },
        { key: "RC-11", status: "fixed", bodyFile: await body("b"), commits: [fixCommit] },
      ]),
      /1 件は下書きを作成できませんでした:\n {2}✖ RC-11: RC-11 の返信の状態は needs_info です/,
    );
    assert.match(out.join("\n"), /--- RC-10（fixed）の投稿する内容/);
    await assert.rejects(
      batch([
        { key: "RC-10", status: "fixed", bodyFile: await body("a"), commits: [fixCommit] },
        { key: "10", status: "fixed", bodyFile: await body("a"), commits: [fixCommit] },
      ]),
      /RC-10 が 2 回含まれています/,
    );
  });

  test("reply --batch --yes は順に投稿し、やり直しても二重返信にならない", async () => {
    const entries = [
      { key: "RC-10", status: "fixed", bodyFile: await body("a"), commits: [fixCommit] },
      { key: "RC-11", status: "needs_info", bodyFile: await body("b") },
    ];
    const text = await batch(entries, true);
    assert.match(text, /返信しました: 2 件 \/ 2 件/);
    assert.equal(posted.length, 2);
    await assert.rejects(batch(entries, true), /2 件は返信できませんでした[\s\S]*すでに fixed[\s\S]*すでに needs_info/);
    assert.equal(posted.length, 2);
  });

  test("一覧を出した後に指摘の状態が変わったら、select は interpret のやり直しを求める", async () => {
    await assert.rejects(run(() => selectCommand(PR, "all", ctx())), /RC-10, RC-11 の状態か解釈が変わりました/);
  });
});

describe("指摘ごとの周りのコード（contexts, 改善案 A-1）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  const ctx = (): CommandContext => ({
    client: {
      getMyself: async () => ({ id: ME, userId: null, name: "me" }),
      getPullRequest: async () => ({ summary: "s", base: "main", branch: "feature", status: { id: 1, name: "Open" } }),
      listAllComments: async () => comments,
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: () => {},
  });
  const items = async () => Object.fromEntries((await fetchCommand(PR, ctx(), true)).items.map((i) => [i.key, i]));
  let lineComment: (id: number, position: number) => BacklogComment;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-context-"));
    work = await mkdtemp(join(tmpdir(), "bfr-context-work-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    const base = Array.from({ length: 40 }, (_, i) => `b${i + 1}`);
    await writeFile(join(repo, "base.ts"), `${base.join("\n")}\n`);
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    base[19] = "changed20";
    await writeFile(join(repo, "base.ts"), `${base.join("\n")}\n`);
    await git("commit", "-q", "-am", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const oldBlobId = (await git("rev-parse", "main:base.ts")).stdout.trim();
    const newBlobId = (await git("rev-parse", "feature:base.ts")).stdout.trim();
    // ファイル全体の差分では、19 行の変更なしの行の後に -b20（position 20）、+changed20（position 21）が並ぶ
    lineComment = (id, position) => ({ ...comment(id, OTHER, "ここを直して"), filePath: "base.ts", position, oldBlobId, newBlobId });
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("行コメントには、指摘された行の前後と、その行を含む差分の hunk を入れる", async () => {
    comments = [lineComment(100, 21), lineComment(102, 20)];
    const all = await items();
    const [added] = all["100"].contexts;
    assert.equal(added.source, "line_comment");
    assert.equal(added.file, "pr_branch");
    assert.equal(added.line, 20);
    assert.deepEqual([added.lines[0].n, added.lines.at(-1)!.n], [5, 35]);
    assert.deepEqual(added.lines.find((l) => l.target), { n: 20, text: "changed20", target: true });
    assert.match(added.hunk ?? "", /^@@ .*\n[\s\S]*-b20\n\+changed20/);

    // 削除された行への行コメントは、変更前のファイルから切り出す
    const [removed] = all["102"].contexts;
    assert.equal(removed.file, "old");
    assert.deepEqual(removed.lines.find((l) => l.target), { n: 20, text: "b20", target: true });
    assert.match(removed.hunk ?? "", /-b20/);
  });

  test("本文の 📍 は CLI が読み取り、本文から読んだ場所として入れる。最新の追加の指示を優先する", async () => {
    comments = [comment(110, OTHER, "📍 base.ts L3 を直して"), comment(120, OTHER, "直して"), comment(121, OTHER, "RC-120 📍 `base.ts` L20 のことです")];
    const all = await items();
    const [marker] = all["110"].contexts;
    assert.equal(marker.source, "body_marker");
    assert.deepEqual(marker.lines.find((l) => l.target), { n: 3, text: "b3", target: true });
    assert.equal(marker.hunk, null);
    assert.equal(all["120"].contexts[0].line, 20);
    assert.match(all["120"].contexts[0].hunk ?? "", /\+changed20/);
  });

  test("場所の手がかりがない指摘、範囲外の行、リポジトリの外を指すパス、解釈済みの指摘には入れない", async () => {
    comments = [comment(130, OTHER, "全体的に見直して"), comment(131, OTHER, "📍 base.ts L99"), comment(132, OTHER, "📍 ../x.ts L1"), lineComment(133, 21)];
    const file = join(work, "interp.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          key: "RC-133",
          points: [
            {
              kind: "fix",
              location: { judgment: "explicit", path: "base.ts", line: 20, reason: "行コメント" },
              intent: { judgment: "clear", reason: "r" },
              scope: { judgment: "local", reason: "r" },
              plan: "p",
            },
          ],
        },
      ]),
    );
    await interpretCommand(PR, file, ctx());
    const all = await items();
    for (const key of ["130", "131", "132", "133"]) assert.deepEqual(all[key].contexts, [], key);
  });
});

describe("コミットの補助コマンド（commit, 改善案 A-5）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  const out: string[] = [];
  const KEY = "SecretKeyForCommitTest123";
  const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  const ctx = (): CommandContext => ({
    client: {
      getMyself: async () => ({ id: ME, userId: null, name: "me" }),
      getPullRequest: async () => ({ summary: "s", base: "main", branch: "feature", status: { id: 1, name: "Open" } }),
      listAllComments: async () => comments,
      containsApiKey: (text: string) => text.includes(KEY),
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const commit = async (key: string, message: string) => {
    const file = join(work, "message.txt");
    await writeFile(file, message);
    out.length = 0;
    await commitCommand(PR, { key, messageFile: file }, ctx());
    return out.join("\n");
  };
  const stage = async (path: string, content: string) => {
    await writeFile(join(repo, path), content);
    await git("add", "--", path);
  };
  const point = (intent: string) => ({
    kind: "fix",
    location: { judgment: "explicit", path: "feature.ts", line: 1, reason: "本文に明記" },
    intent: { judgment: intent, reason: "r" },
    scope: { judgment: "local", reason: "r" },
    plan: "p",
  });

  // commit は利用者の git の設定でコミットするので、テストでは名前とメールを環境変数で与える
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const [k, v] of Object.entries(identity)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    repo = await mkdtemp(join(tmpdir(), "bfr-commit-test-"));
    work = await mkdtemp(join(tmpdir(), "bfr-commit-work-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "base\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "feature.ts"), "line1\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    comments = [comment(10, OTHER, "feature.ts L1 の名前を直して"), comment(11, OTHER, "もう少し良く")];
    const file = join(work, "interp.json");
    await writeFile(file, JSON.stringify([{ key: "RC-10", points: [point("clear")] }, { key: "RC-11", points: [point("ambiguous")] }]));
    await interpretCommand(PR, file, ctx());
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("修正の対象でない指摘や、ステージした変更がなければコミットしない", async () => {
    await assert.rejects(commit("RC-11", "fix: x"), /RC-11 は修正の対象ではありません（返信の状態: needs_info/);
    await assert.rejects(commit("RC-10", "fix: x"), /ステージした変更がありません/);
  });

  test("メッセージに Refs: を付けてコミットし、そのコミットで fixed の下書きが作れる", async () => {
    await stage("feature.ts", "renamed\n");
    const text = await commit("RC-10", "fix: 名前を直す");
    const sha = /コミットしました: ([0-9a-f]{7})/.exec(text)![1];
    assert.equal((await git("log", "-1", "--format=%B")).stdout.trim(), "fix: 名前を直す\n\nRefs: RC-10");
    assert.doesNotMatch(text, /⚠️/);
    const body = join(work, "body.md");
    await writeFile(body, "直しました");
    out.length = 0;
    await replyCommand(PR, { key: "RC-10", status: "fixed", bodyFile: body, commits: [sha], post: false }, ctx());
    assert.match(out.join("\n"), /対応済み/);
    await git("reset", "-q", "--hard", "origin/feature");
  });

  test("別の指摘の Refs: や秘密情報があればコミットしない。場所と合わないファイルは警告する", async () => {
    await stage("feature.ts", "renamed\n");
    await assert.rejects(commit("RC-10", "fix: x\n\nRefs: RC-11"), /別の指摘の Refs: があります（RC-11）/);
    await assert.rejects(commit("RC-10", `fix: ${KEY}`), /API キー らしき文字列/);
    await git("reset", "-q", "--hard", "origin/feature");
    await stage("other.ts", "x\n");
    assert.match(await commit("RC-10", "test: テストだけ\n\nRefs: RC-10"), /⚠️ {2}ステージしたファイルは、指摘の場所や仕様書のファイル（feature\.ts）のどれとも合いません/);
    assert.equal((await git("log", "-1", "--format=%B")).stdout.trim(), "test: テストだけ\n\nRefs: RC-10");
    await git("reset", "-q", "--hard", "origin/feature");
  });

  test("HEAD が PR のブランチの上になければコミットしない", async () => {
    await git("checkout", "-q", "main");
    try {
      await stage("base.ts", "changed\n");
      await assert.rejects(commit("RC-10", "fix: x"), /HEAD が origin\/feature の上にありません/);
    } finally {
      await git("reset", "-q", "--hard", "HEAD");
      await git("checkout", "-q", "feature");
    }
  });
});

describe("interpret --file の読み込み先の制限（plan.md §6-1, 2026-10-12）", () => {
  test("一時ディレクトリの外のファイルは読まず、JSON でないときも内容を出さない", async () => {
    const ctx = { client: {} as never, repoDir: "/", stateRoot: "/", out: () => {} } as unknown as CommandContext;
    await assert.rejects(interpretCommand(PR, "/etc/hostname", ctx), /一時ディレクトリか \.review-state\/ の下/);
    const dir = await mkdtemp(join(tmpdir(), "bfr-interp-"));
    const bad = join(dir, "bad.json");
    await writeFile(bad, "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    await assert.rejects(interpretCommand(PR, bad, ctx), (e: Error) => /JSON として読めません/.test(e.message) && !/ghp_/.test(e.message));
    await rm(dir, { recursive: true, force: true });
  });
});
