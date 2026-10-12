import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BacklogClient } from "./backlog/client.ts";
import { parsePullRequestUrl, type PullRequestRef } from "./backlog/url.ts";
import {
  checkPushCommand,
  commitCommand,
  type CommandContext,
  fetchCommand,
  interpretCommand,
  replyBatchCommand,
  replyCommand,
  selectCommand,
  summaryCommand,
} from "./commands.ts";
import { repositoryRoot } from "./git/git.ts";
import { sanitizeForTerminal } from "./text.ts";

const USAGE = `使い方: node <スキルのディレクトリ>/scripts/cli.js <コマンド> <PR URL> [オプション]

コマンド:
  fetch <PR URL>       コメントを全件取り直して同期し、未対応の指摘を表示する
  status <PR URL>      同期して、すべての指摘の状態を表示する
  interpret <PR URL> --file <解釈.json>
                       エージェントの解釈を検証してランクを決め、確認①の一覧を表示する
  commit <PR URL> --key <RC-123> --message-file <メッセージ.txt>
                       ステージした変更を、指摘 1 件の修正としてコミットする（Refs: を付け、対象か確かめる）
  select <PR URL> --choice <1,3-5|all|none>
                       確認①の回答を、指摘の番号と扱い（修正・質問・回答・見送り）に置き換えて表示する
  reply <PR URL> --key <RC-123> --status <fixed|answered|needs_info|wontfix> --body-file <本文.md>
               [--commit <sha>]... [--yes]
                       指摘に返信する。--yes がなければ投稿内容を表示するだけ
  reply <PR URL> --batch <返信.json> [--yes]
                       複数の返信をまとめて扱う。JSON は [{"key","status","bodyFile","commits"}] の配列
  summary <PR URL> [--yes]
                       サマリーコメントを作成・更新する。--yes がなければ内容を表示するだけ
  check-push <PR URL>  push する前に、出ていくコミットごとの追加行とメッセージを API キー・秘密情報で検査する。
                       見つかれば終了コード 1。PR の元の変更ファイルの範囲外のファイルも示す

共通オプション:
  --repo <dir>         対象リポジトリ（既定: カレントディレクトリ）。事前に git fetch しておくこと
                       状態ファイルはそのリポジトリのルートの .review-state/ に保存する

環境変数:
  BACKLOG_API_KEY  必須
  BACKLOG_SPACE    必須（例: yourspace.backlog.jp）。URL のホストと一致しなければ中止する`;

function loadClient(pr: PullRequestRef): BacklogClient {
  const apiKey = process.env.BACKLOG_API_KEY;
  if (!apiKey) throw new Error("環境変数 BACKLOG_API_KEY が設定されていません");
  return new BacklogClient(pr.space, apiKey);
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      file: { type: "string" },
      key: { type: "string" },
      status: { type: "string" },
      "body-file": { type: "string" },
      commit: { type: "string", multiple: true },
      batch: { type: "string" },
      choice: { type: "string" },
      "message-file": { type: "string" },
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

  // API キーの送り先を固定するため、スペースの指定を必須にする（§6）
  const space = process.env.BACKLOG_SPACE;
  if (!space) throw new Error("環境変数 BACKLOG_SPACE が設定されていません（例: yourspace.backlog.jp）");
  const pr = parsePullRequestUrl(url, space);
  const client = loadClient(pr);
  const repoDir = resolve(values.repo ?? process.cwd());
  const ctx: CommandContext = {
    client,
    repoDir,
    // 状態ファイルは対象リポジトリのルートの .review-state/ に置く（§5）
    stateRoot: await repositoryRoot(repoDir),
    // コメントなど信頼できない文字列を含むので、表示を偽装できる文字を取り除いてから出す（S-6）
    out: (line) => console.log(sanitizeForTerminal(line)),
  };
  const need = (name: string, value: string | undefined): string => {
    if (!value) throw new Error(`--${name} を指定してください`);
    return value;
  };

  switch (command) {
    case "fetch":
      await fetchCommand(pr, ctx);
      return;
    case "status":
      await fetchCommand(pr, ctx, true);
      return;
    case "interpret":
      return interpretCommand(pr, need("file", values.file), ctx);
    case "commit":
      return commitCommand(pr, { key: need("key", values.key), messageFile: need("message-file", values["message-file"]) }, ctx);
    case "select":
      return selectCommand(pr, need("choice", values.choice), ctx);
    case "reply":
      if (values.batch !== undefined) return replyBatchCommand(pr, values.batch, values.yes === true, ctx);
      return replyCommand(
        pr,
        {
          key: need("key", values.key),
          status: need("status", values.status),
          bodyFile: need("body-file", values["body-file"]),
          commits: values.commit ?? [],
          post: values.yes === true,
        },
        ctx,
      );
    case "summary":
      return summaryCommand(pr, values.yes === true, ctx);
    case "check-push":
      return checkPushCommand(pr, ctx);
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(sanitizeForTerminal(`エラー: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
