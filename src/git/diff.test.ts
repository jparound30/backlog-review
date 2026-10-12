import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { BacklogComment } from "../backlog/types.ts";
import { changedFiles, fullFileDiff, locateComment, mapLine, parseDiffLines, parseNameStatus, parsePatch } from "./diff.ts";
import { runGit } from "./git.ts";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/demo-pr3");
const CODE_OLD = "b9022d92b93bd40fe487eb0f03167a4ed00e6fff";
const CODE_NEW = "fbfa90ac7667975bb1f743c18cb9eff41f64fa08";
const API_OLD = "22bf85216724a1f64f1eef72138b20048c7b49b2";
const API_NEW = "a0bce0e2cacf0cbb3abb08555418229678267298";

const fixture = (blobId: string) => readFile(join(FIXTURES, `${blobId}.txt`), "utf8");

describe("Backlog の position を行に変換する（M0 の実例, §2-1）", () => {
  const cases = [
    { file: "src/Code.ts", oldBlob: CODE_OLD, newBlob: CODE_NEW, position: 1, kind: " ", newLine: 1 },
    { file: "src/Code.ts", oldBlob: CODE_OLD, newBlob: CODE_NEW, position: 3, kind: "-", oldLine: 3 },
    { file: "src/Code.ts", oldBlob: CODE_OLD, newBlob: CODE_NEW, position: 4, kind: "+", newLine: 3 },
    { file: "src/Code.ts", oldBlob: CODE_OLD, newBlob: CODE_NEW, position: 22, kind: "+", newLine: 21 },
    { file: "src/Code.ts", oldBlob: CODE_OLD, newBlob: CODE_NEW, position: 29, kind: "+", newLine: 28 },
    { file: "src/backlog-api.ts", oldBlob: API_OLD, newBlob: API_NEW, position: 244, kind: "+", newLine: 188 },
  ] as const;

  for (const c of cases) {
    test(`${c.file} position ${c.position}`, async () => {
      const diff = await fullFileDiff(await fixture(c.oldBlob), await fixture(c.newBlob));
      const hit = diff.find((d) => d.position === c.position);
      assert.ok(hit);
      assert.equal(hit.kind, c.kind);
      if ("newLine" in c) assert.equal(hit.newLine, c.newLine);
      if ("oldLine" in c) assert.equal(hit.oldLine, c.oldLine);
    });
  }

  test("backlog-api.ts の 188 行目の内容が一致する", async () => {
    const diff = await fullFileDiff(await fixture(API_OLD), await fixture(API_NEW));
    const hit = diff.find((d) => d.position === 244);
    assert.equal(hit?.text, "    return JSON.parse(response.getContentText()) as BacklogPullRequestComment[];");
  });
});

test("利用者の git の設定（diff.algorithm）に左右されない（R-9）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bfr-gitconfig-"));
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    await writeFile(join(dir, "config"), "[diff]\n\talgorithm = histogram\n\tindentHeuristic = false\n");
    process.env.GIT_CONFIG_GLOBAL = join(dir, "config");
    // Myers では 2 行目は追加行（新 2 行目）。histogram では削除行（旧 2 行目）になる
    const diff = await fullFileDiff("a\na\n}\n", "a\nb\n}\na\nb\n}\na\n");
    const hit = diff.find((d) => d.position === 2);
    assert.equal(hit?.kind, "+");
    assert.equal(hit?.newLine, 2);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("parseDiffLines", () => {
  test("新規ファイル（-0,0）は 1 行目から数える", () => {
    const lines = parseDiffLines("--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    assert.deepEqual(
      lines.map((l) => [l.position, l.kind, l.newLine]),
      [
        [1, "+", 1],
        [2, "+", 2],
      ],
    );
  });

  test("No newline at end of file は数えない", () => {
    const lines = parseDiffLines("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n");
    assert.deepEqual(
      lines.map((l) => [l.position, l.kind]),
      [
        [1, "-"],
        [2, "+"],
      ],
    );
  });
});

describe("parseNameStatus", () => {
  test("変更・追加・削除・名前の変更・複製。パスは引用されない（R-3）", () => {
    const output = ["M", "src/a.ts", "A", "日本語/新規.ts", "D", "a b.ts", "R087", "src/x.ts", "src/y.ts", "C100", "c.ts", "d.ts", ""].join("\0");
    assert.deepEqual(parseNameStatus(output), [
      { path: "src/a.ts", status: "modified", oldPath: "src/a.ts" },
      { path: "日本語/新規.ts", status: "added", oldPath: null },
      { path: "a b.ts", status: "deleted", oldPath: "a b.ts" },
      { path: "src/y.ts", status: "renamed", oldPath: "src/x.ts" },
      { path: "d.ts", status: "added", oldPath: null },
    ]);
  });
});

describe("parsePatch", () => {
  test("ファイルごとに、変更行の範囲と追加行を集める", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@",
      "+x",
      "+y",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "@@ -20,2 +22,0 @@",
      "-gone1",
      "-gone2",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-z",
      "diff --git a/src/x.ts b/src/y.ts",
      "similarity index 100%",
      "rename from src/x.ts",
      "rename to src/y.ts",
    ].join("\n");
    assert.deepEqual(parsePatch(diff), [
      { newRanges: [{ start: 4, end: 5 }, { start: 12, end: 12 }], added: ["x", "y", "new"] },
      { newRanges: [], added: [] },
      { newRanges: [], added: [] },
    ]);
  });

  test("追加行の内容が見出しに見えても、取り違えない（R-1）", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +2,4 @@",
      "+++ /dev/null",
      "+diff --git a/b b/b",
      "+@@ -1 +1 @@",
      "+secret",
    ].join("\n");
    assert.deepEqual(parsePatch(diff), [
      { newRanges: [{ start: 2, end: 5 }], added: ["++ /dev/null", "diff --git a/b b/b", "@@ -1 +1 @@", "secret"] },
    ]);
  });
});

describe("changedFiles", () => {
  let repo: string;
  const git = (...args: string[]) => runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-changed-"));
    await runGit(repo, ["init", "-q", "-b", "main"]);
    await writeFile(join(repo, "base.ts"), "a\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "base");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(repo, "日本語.ts"), "x\ny\n");
    await writeFile(join(repo, "a b.ts"), "x\n");
    await writeFile(join(repo, "base.ts"), "a\nb\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "feature");
  });
  after(() => rm(repo, { recursive: true, force: true }));

  test("日本語や空白を含むパスをそのまま返す（R-3）", async () => {
    const files = await changedFiles(repo, "main", "feature");
    assert.deepEqual(
      files.map((f) => [f.path, f.status, f.newRanges]).sort(),
      [
        ["a b.ts", "added", [{ start: 1, end: 1 }]],
        ["base.ts", "modified", [{ start: 2, end: 2 }]],
        ["日本語.ts", "added", [{ start: 1, end: 2 }]],
      ].sort(),
    );
  });

  test("利用者の git の設定（noprefix・quotePath・relative）に左右されない", async () => {
    await git("config", "diff.noprefix", "true");
    await git("config", "core.quotePath", "true");
    await git("config", "diff.relative", "true");
    try {
      const files = await changedFiles(repo, "main", "feature");
      assert.deepEqual(files.map((f) => f.path).sort(), ["a b.ts", "base.ts", "日本語.ts"].sort());
    } finally {
      await git("config", "--unset", "diff.noprefix");
      await git("config", "--unset", "diff.relative");
      await git("config", "--unset", "core.quotePath");
    }
  });
});

describe("locateComment", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "bfr-repo-"));
    await runGit(repo, ["init", "-q"]);
    for (const blob of [CODE_OLD, CODE_NEW]) {
      const path = join(repo, `${blob}.txt`);
      await writeFile(path, await fixture(blob));
      await runGit(repo, ["hash-object", "-w", path]);
    }
    // 現在のブランチの src/Code.ts を指摘時点（CODE_NEW）と同じにする
    await runGit(repo, ["update-index", "--add", "--cacheinfo", `100644,${CODE_NEW},src/Code.ts`]);
    const tree = (await runGit(repo, ["write-tree"])).stdout.trim();
    const commit = (
      await runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "t"])
    ).stdout.trim();
    await runGit(repo, ["update-ref", "refs/heads/feature", commit]);
  });

  after(() => rm(repo, { recursive: true, force: true }));

  const comment = (overrides: Partial<BacklogComment>): BacklogComment => ({
    id: 1,
    content: "",
    createdUser: { id: 1, userId: "u", name: "u" },
    created: "",
    updated: "",
    filePath: "src/Code.ts",
    position: 29,
    oldBlobId: CODE_OLD,
    newBlobId: CODE_NEW,
    ...overrides,
  });

  test("同じ blob の組への行コメントは、git を起動し直さずに使い回す（R-17）", async () => {
    const featureCommit = (await runGit(repo, ["rev-parse", "feature"])).stdout.trim();
    const first = await locateComment(repo, comment({ position: 1 }), featureCommit);
    // blob が手元から消えても、1 回の実行の中では読み直さないので、同じ結果になる
    const objects = join(repo, ".git", "objects");
    const hidden = `${objects}-hidden`;
    await rename(objects, hidden);
    try {
      const second = await locateComment(repo, comment({ position: 29 }), featureCommit);
      assert.equal(first?.line, 1);
      assert.equal(second?.line, 28);
      assert.equal(second?.error, null);
    } finally {
      await rename(hidden, objects);
    }
  });

  test("場所を指定しないコメントは null", async () => {
    assert.equal(await locateComment(repo, comment({ filePath: null, position: null }), "feature"), null);
  });

  test("行コメントの場所を求める", async () => {
    const loc = await locateComment(repo, comment({}), "feature");
    assert.equal(loc?.side, "new");
    assert.equal(loc?.line, 28);
    assert.equal(loc?.text, "}");
    assert.equal(loc?.outdated, false);
    assert.equal(loc?.error, null);
  });

  test("削除行への指摘は old 側の行番号", async () => {
    const loc = await locateComment(repo, comment({ position: 3 }), "feature");
    assert.equal(loc?.side, "old");
    assert.equal(loc?.line, 3);
  });

  test("blob が手元にないときは error に理由を入れる", async () => {
    const loc = await locateComment(repo, comment({ newBlobId: "0".repeat(40) }), "feature");
    assert.match(loc?.error ?? "", /git fetch/);
  });

  test("範囲外の position", async () => {
    const loc = await locateComment(repo, comment({ position: 9999 }), "feature");
    assert.match(loc?.error ?? "", /範囲外/);
  });
});

describe("mapLine（ファイルが更新された後の行番号, §2-1）", () => {
  const diffOf = (oldText: string, newText: string) => fullFileDiff(oldText, newText);

  test("変更されていない行は、上の行の増減に合わせてずれる", async () => {
    const diff = await diffOf("a\nb\nc\n", "x\na\nb\nc\n");
    assert.deepEqual(mapLine(diff, 2), { line: 3, changed: false });
  });

  test("行そのものが変更されたら、置き換わった行を指す", async () => {
    const diff = await diffOf("a\nb\nc\n", "a\nB\nc\n");
    assert.deepEqual(mapLine(diff, 2), { line: 2, changed: true });
  });

  test("行が削除されたら、直後の行を指す", async () => {
    const diff = await diffOf("a\nb\nc\n", "a\nc\n");
    assert.deepEqual(mapLine(diff, 2), { line: 2, changed: true });
  });

  test("範囲外は null", async () => {
    assert.deepEqual(mapLine(await diffOf("a\n", "b\n"), 5), { line: null, changed: false });
  });
});
