// tsc が build/scripts に出した JavaScript を、各スキルの scripts/ にコピーする。
// 配布物はスキルのフォルダだけで完結させるので（plan.md §7-A）、共有モジュールも各スキルに同じコピーを入れる
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, selectSkills, skillDir } from "./skills.mjs";

const built = join(repoRoot, "build", "scripts");
if (!existsSync(join(built, "cli.js"))) throw new Error("build/scripts がありません。tsc -p tsconfig.build.json を先に実行してください");

for (const skill of selectSkills(process.argv.slice(2))) {
  const out = join(skillDir(skill.name), "scripts");
  rmSync(out, { recursive: true, force: true });
  cpSync(built, out, { recursive: true });
  // ES モジュールとして実行できるようにする（配布物はリポジトリの package.json の外に置かれるため）
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  if (!existsSync(join(out, skill.entry))) throw new Error(`${skill.name}: scripts/${skill.entry} が生成されていません`);
  console.log(`${skill.name}/scripts/ を更新しました`);
}
