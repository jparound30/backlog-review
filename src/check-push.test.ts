import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { BacklogClient } from "./backlog/client.ts";
import { checkPushCommand, type CommandContext } from "./commands.ts";
import { runGit } from "./git/git.ts";

const PR = { space: "x.backlog.jp", projectKey: "P", repoName: "r", number: 1 };
const KEY = "SecretKeyForTest123";

describe("check-push（公開前チェック S-1）", () => {
  let repo: string;
  const git = (...args: string[]) =>
    runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  const out: string[] = [];
  const ctx = (): CommandContext => ({
    client: {
      getPullRequest: async () => ({ base: "main", branch: "feature" }),
      containsApiKey: (text: string) => text.includes(KEY),
    } as unknown as BacklogClient,
    repoDir: repo,
    stateRoot: repo,
    out: (line) => out.push(line),
  });
  const commitFile = async (path: string, content: string, message = "fix: test") => {
    await writeFile(join(repo, path), content);
    await git("add", path);
    await git("commit", "-q", "-m", message);
  };

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-push-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await commitFile("base.ts", "base\n", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await commitFile("feature.ts", "feature\n", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
  });
  after(() => rm(repo, { recursive: true, force: true }));

  test("push するコミットがなければ、その旨を表示する", async () => {
    out.length = 0;
    await checkPushCommand(PR, ctx());
    assert.match(out.join("\n"), /push するコミットはありません/);
  });

  test("問題がなければ通る", async () => {
    await commitFile("feature.ts", "feature\nfixed\n");
    out.length = 0;
    await checkPushCommand(PR, ctx());
    assert.match(out.join("\n"), /✔ 問題は見つかりませんでした/);
  });

  test("PR の元の変更ファイルの範囲外に触れたら警告する", async () => {
    await commitFile("base.ts", "base\nchanged\n");
    out.length = 0;
    await checkPushCommand(PR, ctx());
    assert.match(out.join("\n"), /base\.ts {2}⚠️ PR の元の変更ファイルの範囲外/);
  });

  test("追加行に API キーがあれば中止する", async () => {
    await commitFile("feature.ts", `feature\nconst k = "${KEY}";\n`);
    await assert.rejects(checkPushCommand(PR, ctx()), /feature\.ts の追加行に API キー/);
    await git("reset", "-q", "--hard", "HEAD~1");
  });

  test("追加行に秘密情報らしき文字列があれば中止する", async () => {
    await commitFile("feature.ts", "feature\nAKIAABCDEFGHIJKLMNOP\n");
    await assert.rejects(checkPushCommand(PR, ctx()), /AWS のアクセスキー/);
    await git("reset", "-q", "--hard", "HEAD~1");
  });

  test("追加行が見出し（+++ /dev/null）に見えても、後に続く API キーを見逃さない（R-1）", async () => {
    await commitFile("feature.ts", `feature\n++ /dev/null\nconst k = "${KEY}";\n`);
    await assert.rejects(checkPushCommand(PR, ctx()), /feature\.ts の追加行に API キー/);
    await git("reset", "-q", "--hard", "HEAD~1");
  });

  test("バイナリのファイルの追加内容も調べる", async () => {
    await commitFile("blob.bin", `\0\0${KEY}\0`);
    await assert.rejects(checkPushCommand(PR, ctx()), /blob\.bin の追加行に API キー/);
    await git("reset", "-q", "--hard", "HEAD~1");
  });

  test("日本語や空白を含むパスを、安全でないパスや範囲外と誤らない（R-3）", async () => {
    await commitFile("a b.ts", "x\n");
    await commitFile("日本語.ts", "x\n");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    await commitFile("a b.ts", "x\ny\n");
    await commitFile("日本語.ts", "x\ny\n");
    out.length = 0;
    await checkPushCommand(PR, ctx());
    const text = out.join("\n");
    assert.match(text, /^ {2}a b\.ts$/m);
    assert.match(text, /^ {2}日本語\.ts$/m);
    assert.match(text, /✔ 問題は見つかりませんでした/);
    await git("reset", "-q", "--hard", "HEAD~2");
  });

  test("途中のコミットで足して後のコミットで消した API キーも見逃さない（R-20）", async () => {
    await commitFile("feature.ts", `feature\nconst k = "${KEY}";\n`, "fix: add");
    await commitFile("feature.ts", "feature\n", "fix: remove");
    await assert.rejects(checkPushCommand(PR, ctx()), /コミット [0-9a-f]{7} の feature\.ts の追加行に API キー/);
    await git("reset", "-q", "--hard", "HEAD~2");
  });

  test("マージで持ち込まれた API キーも見逃さない（R-20）", async () => {
    await git("checkout", "-q", "-b", "side", "origin/feature");
    await commitFile("side.ts", `const k = "${KEY}";\n`, "side");
    await git("checkout", "-q", "feature");
    await git("merge", "-q", "--no-ff", "-m", "merge", "side");
    await assert.rejects(checkPushCommand(PR, ctx()), /side\.ts の追加行に API キー/);
    await git("reset", "-q", "--hard", "origin/feature");
    await git("branch", "-q", "-D", "side");
  });

  test("コミットメッセージに API キーがあれば中止する", async () => {
    await commitFile("feature.ts", "feature\nok\n", `fix: ${KEY}`);
    await assert.rejects(checkPushCommand(PR, ctx()), /メッセージに API キー/);
    await git("reset", "-q", "--hard", "HEAD~1");
  });
});

test("base 側の履歴にあるコミットは、PR の push 済みのコミットとみなさない（S-11）", async () => {
  const { isPushed } = await import("./commands.ts");
  const repo = await mkdtemp(join(tmpdir(), "bfr-pushed-"));
  try {
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "a"), "1\n");
    await git("add", "a");
    await git("commit", "-q", "-m", "base");
    const baseCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "a"), "2\n");
    await git("commit", "-q", "-am", "pr");
    const prCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    assert.equal(await isPushed(repo, prCommit, prCommit, baseCommit), true);
    assert.equal(await isPushed(repo, baseCommit, prCommit, baseCommit), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
