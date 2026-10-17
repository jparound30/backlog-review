/**
 * `export <URL> [--all]`（§5-2）。両方のスキルの CLI から使う（§7-11）。
 * 読み取りだけで、Backlog には何も投稿せず、作業ツリーも状態ファイルも変えない
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BacklogClient } from "../backlog/client.ts";
import type { PullRequestRef } from "../backlog/url.ts";
import { locateComment } from "../git/diff.ts";
import { isObjectId } from "../git/git.ts";
import type { StoredInterpretation } from "../interpret/interpretation.ts";
import { assertNotSymlink, loadState, STATE_ROOT, statePath } from "../state/store.ts";
import { pullRequestUrl, refsOf, validInterpretations } from "../sync.ts";
import { formatCsv, formatMarkdown } from "./format.ts";
import { buildRecords } from "./record.ts";

export type ExportContext = {
  client: BacklogClient;
  repoDir: string;
  stateRoot: string;
  out: (line: string) => void;
};

export type ExportOptions = {
  all: boolean;
  /** 出力したスキル（Markdown に書く） */
  skill: "backlog-fix-review" | "backlog-review";
  /** 対応側の状態ファイルで、まだ返信していない指摘の分類と not_actionable を補う（対応側だけ, §5-2） */
  useFixState: boolean;
  /** セルの秘密情報の検査に使う */
  apiKey?: string;
  now?: Date;
  /** テストのための時差（分）。既定は利用者の環境のタイムゾーン */
  offsetMinutes?: number;
};

function stamp(date: Date, offsetMinutes?: number): string {
  const offset = offsetMinutes ?? -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}${p(local.getUTCMonth() + 1)}${p(local.getUTCDate())}-${p(local.getUTCHours())}${p(local.getUTCMinutes())}${p(local.getUTCSeconds())}`;
}

export function exportDir(stateRoot: string): string {
  return join(stateRoot, STATE_ROOT, "export");
}

export async function exportCommand(pr: PullRequestRef, ctx: ExportContext, options: ExportOptions): Promise<{ csv: string; md: string }> {
  const [myself, pullRequest, comments] = await Promise.all([
    ctx.client.getMyself(),
    ctx.client.getPullRequest(pr),
    ctx.client.listAllComments(pr),
  ]);
  const byId = new Map(comments.map((c) => [c.id, c]));
  const refs = await refsOf(ctx.repoDir, pullRequest);
  const notes: string[] = [];

  let interpretations = new Map<string, StoredInterpretation>();
  let stateCommits: Record<string, string[]> = {};
  if (options.useFixState) {
    const path = statePath(ctx.stateRoot, pr);
    try {
      // 読むだけ。ファイルがなければ空の状態になり、作らない
      const state = await loadState(path, pr);
      if (state.myselfId !== null && state.myselfId !== myself.id) {
        notes.push("状態ファイルは別のユーザーが作ったものなので使っていません");
      } else {
        interpretations = validInterpretations(state, byId);
        stateCommits = Object.fromEntries(Object.entries(state.commits ?? {}).map(([k, shas]) => [k, (shas ?? []).filter(isObjectId)]));
      }
    } catch (error) {
      notes.push(`状態ファイルを読めないので使っていません（${error instanceof Error ? error.message : String(error)}）`);
    }
  } else {
    notes.push("レビュー側で出力したため、まだ自動返信のない指摘の分類と not_actionable の判定は補っていません（対応側で出すと補えます）");
  }

  const prUrl = pullRequestUrl(pr);
  const result = await buildRecords({
    pr,
    prUrl,
    comments,
    myselfId: myself.id,
    locate: (comment) => locateComment(ctx.repoDir, comment, refs.branchCommit),
    interpretations,
    stateCommits,
    all: options.all,
  });

  const now = options.now ?? new Date();
  const csv = formatCsv(result.records, { apiKey: options.apiKey, offsetMinutes: options.offsetMinutes });
  const md = formatMarkdown(result, {
    prUrl,
    title: pullRequest.summary,
    generatedAt: now.toISOString(),
    skill: options.skill,
    notes,
    apiKey: options.apiKey,
    offsetMinutes: options.offsetMinutes,
  });

  // 出力先は固定する（誘導されたエージェントに任意のファイルを書き換えさせない, §5-2）
  const dir = exportDir(ctx.stateRoot);
  await assertNotSymlink(join(ctx.stateRoot, STATE_ROOT));
  await mkdir(dir, { recursive: true });
  await assertNotSymlink(join(ctx.stateRoot, STATE_ROOT));
  await assertNotSymlink(dir);
  const base = join(dir, `${pr.projectKey}-${pr.repoName}-pr${pr.number}-${stamp(now, options.offsetMinutes)}`);
  const csvPath = `${base}.csv`;
  const mdPath = `${base}.md`;
  try {
    await writeFile(csvPath, csv, { flag: "wx", mode: 0o600 });
    await writeFile(mdPath, md, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`同じ名前のファイルがあるため書きませんでした。少し待ってからやり直してください: ${base}`);
    throw error;
  }

  const counted = result.records.filter((r) => r.status !== "not_actionable");
  ctx.out(`対応の記録を出力しました（指摘 ${counted.length} 件、うち完了 ${counted.filter((r) => r.status === "resolved").length} 件）:`);
  ctx.out(`  ${csvPath}`);
  ctx.out(`  ${mdPath}`);
  for (const note of notes) ctx.out(`  注記: ${note}`);
  ctx.out("出力には指摘者の名前とコメントの本文が入ります。共有するときは中身を確かめてください（.review-state/ の下はコミットしないこと）");
  return { csv: csvPath, md: mdPath };
}
