// このリポジトリで配布するスキルの一覧（build / validate / pack が共通で使う）
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** name はフォルダ名（SKILL.md の name と一致）。entry は scripts/ の中の CLI の入口 */
export const SKILLS = [
  { name: "backlog-fix-review", entry: "cli.js" },
  { name: "backlog-review", entry: "review-cli.js" },
];

export const skillDir = (name) => join(repoRoot, "skill", name);

/** 引数でスキル名が指定されていればそれだけ、なければ全部 */
export function selectSkills(argv) {
  const names = argv.filter((a) => !a.startsWith("-"));
  if (names.length === 0) return SKILLS;
  return names.map((n) => {
    const s = SKILLS.find((x) => x.name === n);
    if (!s) throw new Error(`知らないスキルです: ${n}（${SKILLS.map((x) => x.name).join(", ")}）`);
    return s;
  });
}
