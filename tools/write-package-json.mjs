// ビルドした scripts/ を ES モジュールとして実行できるようにする（配布物は package.json の外に置かれるため）
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const out = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "skill", "backlog-fix-review", "scripts");
await writeFile(join(out, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
