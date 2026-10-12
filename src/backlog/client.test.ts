import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BacklogClient } from "./client.ts";

const PR = { space: "example.backlog.jp", projectKey: "PROJ", repoName: "repo", number: 1 };

function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const next = responses.shift();
    if (!next) throw new Error("想定外の呼び出し");
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (data: unknown, status = 200) => () => new Response(JSON.stringify(data), { status });
const noSleep = async () => {};

test("コメントを 100 件ずつ minId で続けて取得する", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const page2 = [{ id: 101 }];
  const { impl, calls } = fakeFetch([json(page1), json(page2)]);
  const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: noSleep });
  const all = await client.listAllComments(PR);
  assert.equal(all.length, 101);
  assert.match(calls[1].url, /minId=101/);
  assert.match(calls[0].url, /order=asc/);
});

test("GET は 429 と 5xx を再試行する", async () => {
  const { impl, calls } = fakeFetch([json({}, 429), json({}, 503), json({ id: 7 })]);
  const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(await client.getMyself(), { id: 7 });
  assert.equal(calls.length, 3);
});

test("POST は 5xx を再試行しない（二重投稿を防ぐ）", async () => {
  const { impl, calls } = fakeFetch([json({}, 500)]);
  const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: noSleep });
  await assert.rejects(client.postComment(PR, "x"), /HTTP 500/);
  assert.equal(calls.length, 1);
});

test("POST は 429 なら再試行する", async () => {
  const { impl, calls } = fakeFetch([json({}, 429), json({ id: 9 })]);
  const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(await client.postComment(PR, "x"), { id: 9 });
  assert.equal(calls.length, 2);
});

test("エラーメッセージに API キーを含めない", async () => {
  const { impl } = fakeFetch([json({ errors: [] }, 401)]);
  const client = new BacklogClient(PR.space, "SECRET-KEY", { fetchImpl: impl, sleep: noSleep });
  await assert.rejects(client.getMyself(), (error: Error) => {
    assert.doesNotMatch(error.message, /SECRET-KEY/);
    assert.match(error.message, /apiKey=\*\*\*/);
    return true;
  });
});

test("API が minId を無視して同じページを返し続けても、止まる（R-18）", async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const { impl, calls } = fakeFetch(Array.from({ length: 5 }, () => json(page)));
  const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: noSleep });
  await assert.rejects(client.listAllComments(PR), /取得位置が進まない/);
  assert.equal(calls.length, 2);
});

test("コメントの一覧の応答が配列でなければ止まる（R-18）", async () => {
  const { impl } = fakeFetch([json({ errors: [] })]);
  const client = new BacklogClient(PR.space, "KEY", { fetchImpl: impl, sleep: noSleep });
  await assert.rejects(client.listAllComments(PR), /配列ではありません/);
});
