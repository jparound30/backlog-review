# バージョンアップの手続き

配布物（`skill/backlog-fix-review/` と `skill/backlog-review/`）を変えて利用者に届けるときの手続き。2 つのスキルは同じリポジトリで同じバージョンを付ける（plan-review.md §7-9）。決まりの経緯は [plan.md](plan.md) の §7-A。

## バージョンの付け方

- 形は `YYYYMMDD.N.0`（例: `20261012.1.0`）
  - `YYYYMMDD`: リリースした日（日本時間）
  - `N`: その日の何回目か。1 から始める
  - 3 つ目の数字はいつも `0`（npm の書式に合わせるためだけに置く）
- 新しさは数として比べる（`20261012.10.0` は `20261012.2.0` より新しい）
- 互換性のない変更かどうかは番号で表さない。`CHANGELOG.md` の「移行で必要なこと」に書く
- 同じ値を次の 3 か所に書く。`npm run validate` が形と一致を検査する
  - `skill/backlog-fix-review/SKILL.md` の `metadata.version`
  - `skill/backlog-review/SKILL.md` の `metadata.version`
  - `package.json` の `version`
- git のタグは `v` を付ける（`v20261012.1.0`）。配布用の zip はスキルごと（`dist/backlog-fix-review-20261012.1.0.zip`・`dist/backlog-review-20261012.1.0.zip`）

## 手順

1. **方針を plan に書く**: 変更の方針を `docs/plan.md` に書いてから実装する（[AGENTS.md](../AGENTS.md) の決まりのとおり）
2. **実装して検査する**: `npm run check` を通す
3. **互換性を確かめる**: 下のチェックリストを確かめ、当てはまるものを CHANGELOG に書く
4. **バージョンを決める**: エージェントが案を出し、利用者が決める
5. **バージョンを書き換える**: 両スキルの `SKILL.md` と `package.json` に同じ値を書く
6. **CHANGELOG を書く**: 両スキルの `CHANGELOG.md` の先頭に、次の形で足す。変更のないスキルには「変更なし」と書く
   ```markdown
   ## 20261012.1.0（2026-10-12）

   ### 変わったこと
   - 利用者から見て変わること

   ### 移行で必要なこと
   - なし（または、利用者・レビュアーがすること）
   ```
7. **plan を更新する**: `docs/plan.md`（と、レビュー側に変更があれば `docs/plan-review.md`）の §9 にリリースを記録する
8. **コミットとタグ**: リリースのコミットを作り、タグを付ける
   ```bash
   git tag v20261012.1.0
   ```
9. **配布物を作って確かめる**: `npm run pack` で zip を作り、空のディレクトリに展開して `node backlog-fix-review/scripts/cli.js --help` と `node backlog-review/scripts/review-cli.js --help` が動くことを確かめる。できればテスト用 PR で `status` も動かす
10. **公開する**: 利用者の承認を得てから、`main` とタグを push し、GitHub のリリースに zip を添える
    ```bash
    git push origin main
    git push origin v20261012.1.0
    ```

## 互換性のチェックリスト

このツールは、以前のバージョンが Backlog に書いたコメントが PR に残り続ける。次を確かめる。

- [ ] 以前のバージョンが書いたマーカー（`[review-bot …]`）・サマリー・返信の書式を、新しいバージョンも読めるか。書式を変えたなら、以前の書式もテストに残す
- [ ] 状態ファイル（`.review-state/`）の形を変えたなら、以前のファイルをどう扱うか（解釈し直し、または `version` を上げて中止）を決め、CHANGELOG に書く
- [ ] CLI のコマンドやオプションを変えたなら、同じリリースで `SKILL.md` と `references/details.md` も直したか
- [ ] 許可設定に関わるコマンドを足したり変えたりしたなら、`references/details.md` の許可設定の例を直し、CHANGELOG に「許可設定の見直しが必要」と書いたか
- [ ] レビュアー向けのルール（`references/reviewer-guide.md`）やサマリーの見方を変えたなら、CHANGELOG に「チームへの周知が必要」と書いたか

## してはいけないこと

- 公開済みのタグを付け直したり、消したりしない。間違えたら、次の番号（`N` を 1 つ上げる）で出し直す
- `skill/*/scripts/` を直接編集しない（`src/` を直して `npm run build`）
- 配布物に、個人を特定できる情報（名前・ユーザー ID・メールアドレス・スペース名・個人の環境のパス）を入れない
