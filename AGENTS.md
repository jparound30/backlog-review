# AGENTS.md

このリポジトリで作業するコーディングエージェント（Claude Code・Codex・Copilot・Cursor など）向けの決まり。`CLAUDE.md` はこのファイルを読み込むだけなので、決まりはここにだけ書く。

## 基準ドキュメント

- 設計・作業の基準は [docs/plan.md](docs/plan.md)。作業を始める前に必ず読むこと。
- 仕様変更や方針の決定は、まず `docs/plan.md` を更新してから実装に反映する。
  - 決まった未決事項は §7 の「決定」列を埋める。
  - 進んだ作業は §8 のチェックを更新する。
  - 変更したら冒頭の「最終更新」と §9 の変更履歴を更新する。
- 実装が `docs/plan.md` と食い違う場合は、黙って直さずに食い違いを報告して方針を確認する。

## 配布物とビルド

- 配布物は `skill/backlog-fix-review/`（Agent Skills の形式）。このフォルダだけで動くようにする（plan §7-A）。
- `skill/backlog-fix-review/scripts/` は `src/` からの生成物。直接編集せず、`src/` を直して `npm run build` する。
- 変更したら `npm run check`（型チェック・ビルド・形式の検証・テスト）を通す。配布用の zip は `npm run pack` で `dist/` に作る。
- 配布物とテストデータに、個人を特定できる情報（名前・ユーザー ID・メールアドレス・スペース名・個人の環境のパス）を入れない。`npm run validate` がパスとメールアドレスを検査する。

## バージョンアップ

- 配布物を変えて利用者に届けるときは、[docs/release.md](docs/release.md) の手続きに従う（バージョンの付け方・互換性の確認・CHANGELOG・タグ）。
- バージョンは日付の形 `YYYYMMDD.N.0`。`skill/backlog-fix-review/SKILL.md` の `metadata.version` と `package.json` の `version` に同じ値を書く。番号はエージェントが案を出し、利用者が決める。
