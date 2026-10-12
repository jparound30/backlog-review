import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const CLI = join(import.meta.dirname, "../skill/backlog-fix-review/scripts/cli.js");

// 配布物の CLI（npm run build で生成）が単独で動くこと
test("配布物の CLI が起動し、使い方を表示する", { skip: !existsSync(CLI) && "npm run build が必要" }, async () => {
  const { stderr } = await promisify(execFile)(process.execPath, [CLI, "--help"]);
  assert.match(stderr, /使い方: node <スキルのディレクトリ>\/scripts\/cli\.js/);
});
