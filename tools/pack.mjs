// 配布用の zip を作る（dist/<name>-<version>.zip）。中身は skill/<name>/ だけ。引数でスキル名を指定できる（省略時は全部）
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, selectSkills, skillDir } from "./skills.mjs";

for (const skill of selectSkills(process.argv.slice(2))) {
  const skillMd = readFileSync(join(skillDir(skill.name), "SKILL.md"), "utf8");
  const version = /^\s+version:\s*"?([^"\n]+)"?/m.exec(skillMd)?.[1] ?? "0.0.0";
  const out = join(repoRoot, "dist", `${skill.name}-${version}.zip`);
  mkdirSync(join(repoRoot, "dist"), { recursive: true });
  rmSync(out, { force: true });
  execFileSync("zip", ["-r", "-X", "-q", out, skill.name, "-x", "*/.DS_Store"], { cwd: join(repoRoot, "skill") });
  console.log(`作成しました: ${out}`);
}
