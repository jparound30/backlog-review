import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type { BacklogClient } from "../backlog/client.ts";
import type { BacklogComment } from "../backlog/types.ts";
import { type CommandContext, interpretCommand } from "../commands.ts";
import { runGit } from "../git/git.ts";
import { formatReply, parseReplyBody } from "../reply/format.ts";
import { SUMMARY_MARKER_TEXT } from "../thread/marker.ts";
import { formatFinding, formatNoFindings } from "../review/finding.ts";
import { exportCommand, type ExportContext } from "./command.ts";
import { csvCell, formatTime, SECRET_OMITTED } from "./format.ts";

const PR = { space: "x.backlog.jp", projectKey: "P", repoName: "r", number: 1 };
const AUTHOR = 1; // PR の作成者（対応側）
const REVIEWER = 2;
const JST = 540;

const comment = (id: number, user: number, content: string, created = "2026-10-12T00:00:00Z"): BacklogComment => ({
  id,
  content,
  createdUser: { id: user, userId: null, name: `user${user}` },
  created,
  updated: created,
});

describe("自動返信の本文の読み戻し（§5-2）", () => {
  const base = { key: "10", replyTo: 10, reviewerName: "a", quoteSource: "q", location: null, commits: [] as string[] };

  test("見出しの行から、CLI が後に書く行の前までを読む。複数行の本文も読む", () => {
    const fixed = formatReply({ ...base, status: "fixed", body: "1 行目\n\n2 行目", commits: ["0123456789abcdef0123456789abcdef01234567"] });
    assert.equal(parseReplyBody(fixed), "1 行目\n\n2 行目");
    const needs = formatReply({ ...base, status: "needs_info", body: "どちらですか", rankReasons: ["直し方が 1 通りに決まらない"] });
    assert.equal(parseReplyBody(needs), "どちらですか");
  });

  test("本文に CLI の行と同じ形の文があっても、本文の終わりを取り違えない", () => {
    const answered = formatReply({ ...base, status: "answered", body: "回答\n**コミット**: deadbee" });
    assert.equal(parseReplyBody(answered), "回答\n**コミット**: deadbee");
    assert.equal(parseReplyBody("マーカーのないコメント"), null);
  });
});

describe("CSV のセルと時刻（§5-2）", () => {
  test("数式として働く先頭の文字に ' を付け、引用符を逃がす。改行はセルの中に LF で残す", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell("+1"), `"'+1"`);
    assert.equal(csvCell("-1"), `"'-1"`);
    assert.equal(csvCell("@SUM(A1)"), `"'@SUM(A1)"`);
    assert.equal(csvCell("a\nb\r\nc\rd"), `"a\nb\nc\nd"`);
    assert.equal(csvCell("x\u202ey\u0007"), `"xy"`);
  });

  test("秘密情報らしき文字列と API キーは、セルごと省く", () => {
    assert.equal(csvCell(`token: ghp_${"a".repeat(36)}`), `"${SECRET_OMITTED}"`);
    assert.equal(csvCell("key is abcdefghijklmnop0123456789", "abcdefghijklmnop0123456789"), `"${SECRET_OMITTED}"`);
  });

  test("時刻は利用者の環境のタイムゾーンで YYYY-MM-DD HH:mm", () => {
    assert.equal(formatTime("2026-10-12T15:30:00Z", JST), "2026-10-13 00:30");
    assert.equal(formatTime(null), "");
  });
});

describe("export（§5-2, M16）", () => {
  let repo: string;
  let work: string;
  let comments: BacklogComment[];
  let baseComments: BacklogComment[];
  const out: string[] = [];
  const client = (myself: number) =>
    ({
      getMyself: async () => ({ id: myself, userId: null, name: `user${myself}` }),
      getPullRequest: async () => ({ summary: "機能の追加", base: "main", branch: "feature", status: { id: 1, name: "Open" }, createdUser: { id: AUTHOR } }),
      listAllComments: async () => comments,
    }) as unknown as BacklogClient;
  const fixCtx = (): CommandContext & ExportContext => ({ client: client(AUTHOR), repoDir: repo, stateRoot: repo, out: (l) => out.push(l) });
  const reviewCtx = (): ExportContext => ({ client: client(REVIEWER), repoDir: repo, stateRoot: repo, out: (l) => out.push(l) });
  let n = 0;
  const run = async (side: "fix" | "review", all = false) => {
    out.length = 0;
    const paths = await exportCommand(PR, side === "fix" ? fixCtx() : reviewCtx(), {
      all,
      skill: side === "fix" ? "backlog-fix-review" : "backlog-review",
      useFixState: side === "fix",
      now: new Date(Date.UTC(2026, 9, 17, 0, 0, n++)),
      offsetMinutes: JST,
    });
    return { csv: await readFile(paths.csv, "utf8"), md: await readFile(paths.md, "utf8"), paths };
  };
  const row = (csv: string, key: string) => csv.split("\r\n").find((l) => l.includes(`"${key}"`));

  const sha = "0123456789abcdef0123456789abcdef01234567";
  const reply = (key: string, status: "fixed" | "answered", body: string, category?: "design") =>
    formatReply({ key, replyTo: Number(key), reviewerName: "user2", quoteSource: "q", status, location: null, body, commits: status === "fixed" ? [sha] : [], category });

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-export-"));
    work = await mkdtemp(join(tmpdir(), "bfr-export-work-"));
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

    const finding = formatFinding({
      path: "feature.ts", line: 1, side: "new", severity: "warning", category: "error_handling", kind: "fix",
      title: "例外を握りつぶしている", expected: "再スローする", background: null, evidence: null,
    });
    comments = [
      comment(10, REVIEWER, "変数名を data にしてください", "2026-10-12T00:00:00Z"),
      comment(11, AUTHOR, reply("10", "fixed", "data に改名しました", "design"), "2026-10-12T01:00:00Z"),
      comment(12, REVIEWER, "RC-10 ✅", "2026-10-14T00:00:00Z"),
      comment(20, REVIEWER, finding),
      // 以前の版の返信（分類の行なし）
      comment(21, AUTHOR, reply("20", "answered", "意図的です")),
      comment(22, REVIEWER, "RC-20 理由を教えてください"),
      comment(30, AUTHOR, `## サマリー\n\n${SUMMARY_MARKER_TEXT}`),
      comment(40, REVIEWER, formatNoFindings({ fileCount: 1, baseCommit: "a".repeat(40), branchCommit: "b".repeat(40), base: "main", branch: "feature" })),
      comment(50, REVIEWER, "LGTM"),
      comment(60, REVIEWER, "入力の検証が足りないのでは"),
      comment(70, REVIEWER, "=HYPERLINK(\"https://example.invalid\") を見て"),
      comment(71, AUTHOR, reply("70", "answered", `設定は ghp_${"b".repeat(36)} です`)),
    ];
    // 対応側の状態ファイル（not_actionable と、返信前の指摘の分類）
    const point = (kind: string) => ({
      kind,
      location: { judgment: "unknown", path: null, line: null, reason: "r" },
      intent: { judgment: "clear", reason: "r" },
      scope: { judgment: "local", reason: "r" },
      plan: "p",
    });
    const file = join(work, "interp.json");
    await writeFile(file, JSON.stringify([
      { key: "RC-50", points: [point("not_actionable")] },
      { key: "RC-60", category: "security", points: [point("answer")] },
    ]));
    await interpretCommand(PR, file, fixCtx());
    baseComments = comments;
  });
  // 途中で失敗したテストが comments を差し替えたままにしても、ほかのテストに波及しないようにする
  afterEach(() => {
    comments = baseComments;
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("CSV は BOM 付き・CRLF・すべて引用符で、指摘 1 件 = 1 行。サマリーと「指摘なし」は行にせず注記に出す", async () => {
    const { csv, md } = await run("fix");
    assert.ok(csv.startsWith("\ufeff\"PR\",\"RC\",\"指摘日時\""));
    assert.ok(csv.endsWith("\r\n"));
    assert.deepEqual(
      csv.split("\r\n").slice(1, -1).map((l) => /"(RC-\d+)"/.exec(l)?.[1]),
      ["RC-10", "RC-20", "RC-60", "RC-70"],
    );
    assert.match(md, /行にしなかった「指摘なし」のコメント: #40/);
    assert.match(md, /返信しない指摘（not_actionable）1 件は出していません/);
  });

  test("解決した指摘: 分類・対応区分・対応内容・コミット・解決日時と解決者・往復の回数", async () => {
    const { csv, md } = await run("fix");
    const cells = row(csv, "RC-10")!.slice(1, -1).split('","');
    const header = csv.replace(/^\ufeff/, "").split("\r\n")[0].slice(1, -1).split('","');
    const at = (name: string) => cells[header.indexOf(name)];
    assert.deepEqual(
      header.filter((h) => h !== "やり取り").map(at),
      [
        "P/r#1", "RC-10", "2026-10-12 09:00", "user2", "人間", "", "設計・保守性", "変数名を data にしてください", "変数名を data にしてください", "",
        "resolved", "修正", "data に改名しました", "0123456", "2026-10-12 10:00", "2026-10-14 09:00", "user2", "1", "0",
        "https://x.backlog.jp/git/P/r/pullRequests/1#comment-10",
      ],
    );
    // やり取り: 時系列に、日時・投稿者・種類を付けて並べる
    const history = at("やり取り");
    assert.match(history, /^【1】2026-10-12 09:00 user2（指摘）: 変数名を data にしてください\n【2】2026-10-12 10:00 user1（自動返信・fixed）: :computer: 自動対応 ↩️ RC-10 への返信[^\n]*\n[\s\S]*\n\*\*対応内容\*\*: data に改名しました\n[\s\S]*\n【3】2026-10-14 09:00 user2（解決）: RC-10 ✅$/);
    assert.match(md, /- 指摘: 4 件/);
    assert.match(md, /- 完了（resolved）: 1 件（25%）/);
    assert.match(md, /- 修正した指摘.*: 1 件/);
    assert.match(md, /- 解決までの日数: 中央値 2\.0 日・最大 2\.0 日（解決した 1 件）/);
    assert.match(md, /\| 設計・保守性 \| 1 \|/);
  });

  test("自動レビューの指摘は、出どころ・重大度・本文の分類・`指摘:` の要約・場所を出す", async () => {
    const { csv } = await run("fix");
    const r20 = row(csv, "RC-20")!;
    assert.match(r20, /"自動レビュー","warning","エラー処理","例外を握りつぶしている","[^"]*\n指摘: 例外を握りつぶしている\n期待: 再スローする\n[^"]*","feature\.ts L1","open","回答","意図的です"/);
    assert.match(r20, /"1","1",/);
  });

  test("数式に見えるセルと秘密情報", async () => {
    const { csv, md } = await run("fix");
    const r70 = row(csv, "RC-70")!;
    assert.match(r70, /"'=HYPERLINK\(""https:\/\/example\.invalid""\) を見て"/);
    assert.ok(r70.includes(`"${SECRET_OMITTED}"`));
    assert.doesNotMatch(csv + md, /ghp_/);
  });

  test("どちらのスキルで出しても、自動返信の付いた指摘は同じ行になる。状態ファイルで補う値だけが違い、注記に出る", async () => {
    const fix = await run("fix");
    const review = await run("review");
    for (const key of ["RC-10", "RC-20", "RC-70"]) assert.equal(row(review.csv, key), row(fix.csv, key), key);
    // 返信前の指摘の分類は、対応側の解釈からだけ補える
    assert.match(row(fix.csv, "RC-60")!, /"セキュリティ"/);
    assert.doesNotMatch(row(review.csv, "RC-60")!, /"セキュリティ"/);
    assert.match(fix.md, /分類を、対応側の状態ファイルの解釈で補った指摘: RC-60/);
    // not_actionable の判定もレビュー側にはない
    assert.match(row(review.csv, "RC-50")!, /"open"/);
    assert.match(review.md, /レビュー側で出力したため/);
    // 対応側のサマリーは、レビュー側から見ると他人のコメントだが、行にしない
    assert.match(review.md, /行にしなかったサマリーコメント: #30/);
  });

  test("記録なので、要約・指摘者・場所は長くても省略しない（CSV と Markdown の両方）", async () => {
    const saved = comments;
    const long = `${"とても長い指摘の文。".repeat(30)}最後の文`;
    const longPath = `${"dir/".repeat(30)}feature.ts`;
    comments = [{ ...comment(90, REVIEWER, `${long}\n場所: ${longPath} L1`), createdUser: { id: REVIEWER, userId: null, name: "名前".repeat(40) } }];
    const { csv, md } = await run("fix");
    for (const text of [csv, md]) {
      assert.ok(text.includes(long), "要約");
      assert.ok(text.includes("名前".repeat(40)), "指摘者");
      assert.ok(text.includes(`${longPath} L1`), "場所");
      assert.doesNotMatch(text, /…/);
    }
    comments = saved;
  });

  test("CSV の本文には、元のコメントの 2 行目以降も含めて、改行を残した全文を入れる。Markdown の一覧の表には入れない", async () => {
    const saved = comments;
    comments = [comment(95, REVIEWER, "1 行目の要約\r\n\r\n2 行目の詳しい説明\n3 行目の補足")];
    const { csv, md } = await run("fix");
    assert.match(row(csv, "RC-95")!, /"1 行目の要約","1 行目の要約\n\n2 行目の詳しい説明\n3 行目の補足"/);
    // 行の区切りは CRLF、セルの中は LF なので、行の数は指摘の数と同じ
    assert.equal(csv.split("\r\n").length, 3);
    assert.match(csv, /^\ufeff"PR","RC","指摘日時","指摘者","出どころ","重大度","分類","要約","本文","場所"/);
    assert.doesNotMatch(md.slice(md.indexOf("## 一覧"), md.indexOf("## やり取り")), /2 行目の詳しい説明/);
    comments = saved;
  });

  test("やり取り: 追加の指示も時系列に入る。秘密情報は、そのコメントの本文だけを省く", async () => {
    const { csv } = await run("fix");
    const r20 = row(csv, "RC-20")!;
    assert.match(r20, /【1】2026-10-12 09:00 user2（指摘）: :computer: 自動レビュー [\s\S]*\n【2】2026-10-12 09:00 user1（自動返信・answered）: [\s\S]*\n【3】2026-10-12 09:00 user2（追加の指示・回答）: RC-20 理由を教えてください"/);
    const r70 = row(csv, "RC-70")!;
    assert.match(r70, /【1】2026-10-12 09:00 user2（指摘）: =HYPERLINK\(""https:\/\/example\.invalid""\) を見て\n【2】2026-10-12 09:00 user1（自動返信・answered）: （秘密情報らしき文字列のため省略）"/);
  });

  test("Markdown のやり取り: 指摘ごとに、時系列の番号付きの一覧と、改行を残した引用。リンクや画像は働かない", async () => {
    const saved = comments;
    comments = [
      comment(96, REVIEWER, "1 行目\n\n![画像](https://example.invalid/x.png) と [リンク](https://example.invalid)", "2026-10-12T00:00:00Z"),
      comment(97, AUTHOR, formatReply({ key: "96", replyTo: 96, reviewerName: "user2", quoteSource: "q", status: "answered", location: null, body: "回答です", commits: [] }), "2026-10-12T01:00:00Z"),
      comment(98, REVIEWER, "RC-96 ✅", "2026-10-13T00:00:00Z"),
    ];
    const { md } = await run("fix");
    const section = md.slice(md.indexOf("## やり取り"));
    assert.match(section, /^## やり取り\n\n### <a id="history-rc-96"><\/a>RC-96: 1 行目\n\n\[一覧に戻る\]\(#rc-96\)\n\n1\. 2026-10-12 09:00 user2（指摘）\n   > 1 行目\n   >\n   > \\!\\\[画像\\\]\\\(`https:\/\/example\.invalid\/x\.png`\\\)/);
    assert.match(section, /\n2\. 2026-10-12 10:00 user1（自動返信・answered）\n   > :computer: 自動対応/);
    assert.match(section, /\n3\. 2026-10-13 09:00 user2（解決）\n   > RC-96 ✅\n$/);
    assert.doesNotMatch(section, /\]\(https:/);
    // 一覧の行からやり取りへ、やり取りから一覧の行へ。リンク先の ID がファイルの中にある
    assert.match(md, /\n\| <a id="rc-96"><\/a>\[RC-96\]\(#history-rc-96\) \| 2026-10-12 09:00 \|/);
    for (const [, target] of md.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(md.includes(`<a id="${target}"></a>`), target);
    comments = saved;
  });

  test("--all で not_actionable も出す", async () => {
    const { csv } = await run("fix", true);
    assert.match(row(csv, "RC-50")!, /"not_actionable"/);
  });

  test("状態ファイルがなければ作らない。別のユーザーの状態ファイルは使わない", async () => {
    const statePathOf = join(repo, ".review-state", "P-r-pr1.json");
    const saved = await readFile(statePathOf, "utf8");
    await rm(statePathOf);
    await run("fix");
    await assert.rejects(stat(statePathOf), /ENOENT/);
    await writeFile(statePathOf, saved.replace(`"myselfId": ${AUTHOR}`, `"myselfId": 999`));
    const { md, csv } = await run("fix");
    assert.match(md, /状態ファイルは別のユーザーが作ったものなので使っていません/);
    assert.doesNotMatch(row(csv, "RC-60")!, /"セキュリティ"/);
    await writeFile(statePathOf, saved);
  });

  test("出力先は .review-state/export/ に固定。同じ名前のファイルは上書きせず、シンボリックリンクは拒否する", async () => {
    const before = (await readdir(join(repo, ".review-state", "export"))).length;
    const now = new Date(Date.UTC(2026, 9, 18));
    const opts = { all: false, skill: "backlog-fix-review" as const, useFixState: true, now, offsetMinutes: JST };
    const first = await exportCommand(PR, fixCtx(), opts);
    assert.match(first.csv, /\.review-state\/export\/P-r-pr1-20261018-090000\.csv$/);
    assert.equal(((await stat(first.csv)).mode & 0o777).toString(8), "600");
    await assert.rejects(exportCommand(PR, fixCtx(), opts), /同じ名前のファイルがあるため/);
    assert.equal((await readdir(join(repo, ".review-state", "export"))).length, before + 2);

    const other = await mkdtemp(join(tmpdir(), "bfr-export-link-"));
    await rm(join(repo, ".review-state", "export"), { recursive: true });
    await symlink(other, join(repo, ".review-state", "export"));
    await assert.rejects(exportCommand(PR, fixCtx(), { ...opts, now: new Date() }), /シンボリックリンク/);
    assert.deepEqual(await readdir(other), []);
    await rm(join(repo, ".review-state", "export"));
    await mkdir(join(repo, ".review-state", "export"));
    await rm(other, { recursive: true, force: true });
  });

  test("自分の返信マーカーでない返信（担当の交代など）も、記録では自動返信として読む", async () => {
    const saved = comments;
    comments = [comment(80, REVIEWER, "質問です"), comment(81, 3, `${reply("80", "answered", "答えます")}`)];
    const { csv } = await run("fix");
    assert.match(row(csv, "RC-80")!, /"answered","回答","答えます"/);
    comments = saved;
  });
});
