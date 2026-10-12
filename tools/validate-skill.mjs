// 配布物（skill/backlog-fix-review/）が Agent Skills の形式に沿っているかを確かめる
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skill", "backlog-fix-review");
const errors = [];
const warnings = [];

const skillMd = readFileSync(join(root, "SKILL.md"), "utf8");
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillMd);
if (!fm) errors.push("SKILL.md の先頭に YAML の frontmatter がありません");
const fields = Object.fromEntries(
  (fm?.[1] ?? "").split("\n").filter((l) => /^[a-z-]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
);

// name: 1〜64 文字の小文字英数字とハイフン。ディレクトリ名と一致する
const name = fields.name ?? "";
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push(`name が形式に合いません: ${name}`);
if (name !== basename(root)) errors.push(`name（${name}）がディレクトリ名（${basename(root)}）と一致しません`);
// description: 1〜1024 文字
const description = fields.description ?? "";
if (description.length === 0 || description.length > 1024) errors.push(`description の長さが範囲外です: ${description.length}`);
if (fields.compatibility && fields.compatibility.length > 500) errors.push("compatibility が 500 文字を超えています");
const allowed = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
for (const key of Object.keys(fields)) if (!allowed.has(key)) errors.push(`frontmatter に仕様にない項目があります: ${key}`);

const lines = skillMd.split("\n").length;
if (lines > 500) warnings.push(`SKILL.md が ${lines} 行あります（500 行以下を推奨）`);

// 文書の相対リンク先が存在する（リンクは各ファイルの場所からの相対パス）
for (const file of ["SKILL.md", "README.md", "CHANGELOG.md", "references/details.md", "references/interpretation.md", "references/reviewer-guide.md"]) {
  const text = readFileSync(join(root, file), "utf8");
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
    if (/^[a-z]+:/.test(target)) continue;
    if (!existsSync(join(root, dirname(file), target))) errors.push(`${file} のリンク先がありません: ${target}`);
  }
}

if (!existsSync(join(root, "scripts", "cli.js"))) errors.push("scripts/cli.js がありません。npm run build を実行してください");

// バージョン（docs/release.md）: 形は YYYYMMDD.N.0。SKILL.md と package.json で同じ値。CHANGELOG に載っている
const version = /^\s+version:\s*"?([^"\n]+)"?/m.exec(skillMd)?.[1] ?? "";
const m = /^(\d{4})(\d{2})(\d{2})\.([1-9]\d*)\.0$/.exec(version);
const validDate = m && (() => {
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
})();
if (!validDate) errors.push(`SKILL.md の metadata.version が YYYYMMDD.N.0 の形ではありません: ${version}`);
const pkgVersion = JSON.parse(readFileSync(join(root, "..", "..", "package.json"), "utf8")).version;
if (pkgVersion !== version) errors.push(`package.json の version（${pkgVersion}）が SKILL.md（${version}）と一致しません`);
const changelog = existsSync(join(root, "CHANGELOG.md")) ? readFileSync(join(root, "CHANGELOG.md"), "utf8") : "";
if (!new RegExp(`^## ${version.replace(/\./g, "\\.")}（`, "m").test(changelog)) errors.push(`CHANGELOG.md に ${version} の項目がありません`);

// 個人の環境や個人情報が紛れ込んでいないか
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const file of walk(root)) {
  const text = readFileSync(file, "utf8");
  if (/\/(home|Users|mnt)\/[A-Za-z0-9._-]+\//.test(text)) errors.push(`個人の環境のパスが含まれています: ${file}`);
  // 見えない文字（制御文字・bidi・ゼロ幅など）は、コードの見た目と動作をずらせるので入れない
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u2028\u2029\ufeff]/.test(text)) errors.push(`見えない文字が含まれています: ${file}`);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(text.replace(/noreply@anthropic\.com/g, ""))) {
    errors.push(`メールアドレスらしき文字列が含まれています: ${file}`);
  }
}

for (const w of warnings) console.log(`⚠️  ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`✖ ${e}`);
  process.exit(1);
}
console.log(`✔ ${root} は Agent Skills の形式に沿っています`);
