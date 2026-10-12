import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

// 配布物の CLI（npm run build で生成）が、スキルのフォルダだけで動くこと
const ENTRIES = [
  { skill: "backlog-fix-review", entry: "cli.js" },
  { skill: "backlog-review", entry: "review-cli.js" },
];

for (const { skill, entry } of ENTRIES) {
  const cli = join(import.meta.dirname, "../skill", skill, "scripts", entry);
  test(`${skill} の CLI が起動し、使い方を表示する`, { skip: !existsSync(cli) && "npm run build が必要" }, async () => {
    const { stderr } = await promisify(execFile)(process.execPath, [cli, "--help"]);
    assert.match(stderr, new RegExp(`使い方: node <スキルのディレクトリ>/scripts/${entry.replace(".", "\\.")}`));
  });
}
