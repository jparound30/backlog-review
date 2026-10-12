// レビューする側のスキル backlog-review の CLI の入口（docs/plan-review.md §4-2）。
// 同期・差分・マーカーの実装は対応側（cli.ts）と共有する
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BacklogClient } from "./backlog/client.js";
import { parsePullRequestUrl } from "./backlog/url.js";
import { repositoryRoot } from "./git/git.js";
import { draftCommand, postCommand, resolveCommand, reviewFetchCommand, reviewSelectCommand, verifyCommand, } from "./review/commands.js";
import { sanitizeForTerminal } from "./text.js";
const USAGE = `使い方: node <スキルのディレクトリ>/scripts/review-cli.js <コマンド> <PR URL> [オプション]

コマンド:
  fetch <PR URL>       PR・コメント・差分を同期し、レビュー用のスナップショット（JSON）を保存する
  status <PR URL>      同期して、指摘とその状態を一覧する
  draft <PR URL> --file <findings.json>
                       エージェントの指摘を検証して書式に整え、確認①の一覧を表示する
  select <PR URL> --choice <1,3-5|all|none>
                       確認①の回答を、投稿する指摘の番号に置き換えて表示する
  post <PR URL> [--yes]
                       選ばれた指摘を投稿する。--yes がなければ本文を表示するだけ
  verify <PR URL>      対応側の返信があってレビュアーの番になっている指摘を、コミットと差分とともに表示する
  resolve <PR URL> --batch <結果.json> [--yes]
                       再レビューの結果（解決・再指摘・回答）を投稿する。--yes がなければ本文を表示するだけ

共通オプション:
  --repo <dir>         対象リポジトリ（既定: カレントディレクトリ）。事前に git fetch しておくこと
                       状態ファイルはそのリポジトリのルートの .review-state/ に保存する

環境変数:
  BACKLOG_API_KEY  必須
  BACKLOG_SPACE    必須（例: yourspace.backlog.jp）。URL のホストと一致しなければ中止する`;
function loadClient(pr) {
    const apiKey = process.env.BACKLOG_API_KEY;
    if (!apiKey)
        throw new Error("環境変数 BACKLOG_API_KEY が設定されていません");
    return new BacklogClient(pr.space, apiKey);
}
async function main(argv) {
    const { positionals, values } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            repo: { type: "string" },
            file: { type: "string" },
            choice: { type: "string" },
            batch: { type: "string" },
            yes: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [command, url] = positionals;
    if (values.help || !command || !url) {
        console.error(USAGE);
        process.exitCode = values.help ? 0 : 1;
        return;
    }
    // API キーの送り先を固定するため、スペースの指定を必須にする（plan.md §6）
    const space = process.env.BACKLOG_SPACE;
    if (!space)
        throw new Error("環境変数 BACKLOG_SPACE が設定されていません（例: yourspace.backlog.jp）");
    const pr = parsePullRequestUrl(url, space);
    const client = loadClient(pr);
    const repoDir = resolve(values.repo ?? process.cwd());
    const ctx = {
        client,
        repoDir,
        stateRoot: await repositoryRoot(repoDir),
        // コメントや差分など信頼できない文字列を含むので、表示を偽装できる文字を取り除いてから出す（S-6）
        out: (line) => console.log(sanitizeForTerminal(line)),
    };
    switch (command) {
        case "fetch":
            await reviewFetchCommand(pr, ctx);
            return;
        case "status":
            await reviewFetchCommand(pr, ctx, true);
            return;
        case "draft":
            if (!values.file)
                throw new Error("--file を指定してください");
            return draftCommand(pr, values.file, ctx);
        case "select":
            if (!values.choice)
                throw new Error("--choice を指定してください");
            return reviewSelectCommand(pr, values.choice, ctx);
        case "post":
            return postCommand(pr, values.yes === true, ctx);
        case "verify":
            return verifyCommand(pr, ctx);
        case "resolve":
            if (!values.batch)
                throw new Error("--batch を指定してください");
            return resolveCommand(pr, values.batch, values.yes === true, ctx);
        default:
            console.error(USAGE);
            process.exitCode = 1;
    }
}
main(process.argv.slice(2)).catch((error) => {
    console.error(sanitizeForTerminal(`エラー: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
});
