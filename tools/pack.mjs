// 配布用の zip を作る（dist/backlog-fix-review-<version>.zip）。中身は skill/backlog-fix-review/ だけ
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillMd = readFileSync(join(repo, "skill", "backlog-fix-review", "SKILL.md"), "utf8");
const version = /^\s+version:\s*"?([^"\n]+)"?/m.exec(skillMd)?.[1] ?? "0.0.0";
const out = join(repo, "dist", `backlog-fix-review-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-r", "-X", "-q", out, "backlog-fix-review", "-x", "*/.DS_Store"], { cwd: join(repo, "skill") });
console.log(`作成しました: ${out}`);
