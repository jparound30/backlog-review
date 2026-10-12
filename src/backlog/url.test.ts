import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePullRequestUrl } from "./url.ts";

test("PR の URL を解析する", () => {
  assert.deepEqual(parsePullRequestUrl("https://example.backlog.jp/git/PROJ/my-repo/pullRequests/42"), {
    space: "example.backlog.jp",
    projectKey: "PROJ",
    repoName: "my-repo",
    number: 42,
  });
});

test("Backlog 以外のホストは拒否する", () => {
  assert.throws(() => parsePullRequestUrl("https://evil.example.com/git/PROJ/repo/pullRequests/1"));
});

test("BACKLOG_SPACE と一致しないホストは拒否する", () => {
  assert.throws(() =>
    parsePullRequestUrl("https://other.backlog.jp/git/PROJ/repo/pullRequests/1", "example.backlog.jp"),
  );
});

test("http や PR 以外のパスは拒否する", () => {
  assert.throws(() => parsePullRequestUrl("http://example.backlog.jp/git/PROJ/repo/pullRequests/1"));
  assert.throws(() => parsePullRequestUrl("https://example.backlog.jp/git/PROJ/repo/tree/main"));
});
