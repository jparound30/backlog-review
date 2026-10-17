# backlog-review

Backlog の PR の差分をコードレビューし、**あなたが選んだ指摘を PR のコメントとして投稿する**エージェント用のスキルです。指摘は、対になるスキル `backlog-fix-review` が読み取って自動修正できる書式で投稿します。対応側が修正して返信したら、もう一度このスキルを実行すると、修正を確かめて解決（`RC-番号 ✅`）か再指摘を返します。

[Agent Skills](https://agentskills.io) の形式なので、Claude Code など対応するエージェントで使えます。

> **非公式のツールです。** 株式会社ヌーラボとは関係がなく、同社による提供・保証・サポートはありません。Backlog は株式会社ヌーラボの商標です。

> **試験運用中です。** 初回レビューと再レビューの両方が動きます。

## 必要なもの

- Agent Skills に対応し、シェルのコマンドを実行できるエージェント
- Node.js 20 以上と git（`npm install` は不要）
- Backlog の API キー（個人設定 → API で発行）。キーは**あなたのすべての権限**を持つので、チャットに貼ったりコミットしたりしない
- 対象リポジトリの clone

## 導入

1. **スキルを置く**: このフォルダを、名前を変えずにスキルの置き場所へコピーします。
   ```bash
   cp -R backlog-review ~/.claude/skills/
   ```
2. **環境変数を設定する**: `backlog-fix-review` と同じです。`BACKLOG_SPACE` 以外のホストには API キーを送りません。
   ```bash
   export BACKLOG_API_KEY='（API キー）'
   export BACKLOG_SPACE='yourspace.backlog.jp'
   ```
3. **許可設定を確かめる**: 自動承認のモードでは使わず、`curl` などの任意のコマンドを許可しないでください。

## 使い方

対象リポジトリの clone でエージェントを起動し、URL を示して頼みます。

```
https://yourspace.backlog.jp/git/PROJECT/repo/pullRequests/42 をレビューして
```

エージェントは差分を読んで指摘の一覧を出し、**2 回**あなたに確認を求めます。

1. **確認①**: 一覧を見て、投稿する指摘を `1,3-5` / `all` / `none` で選ぶ
2. **確認②**: 投稿する本文の全文を見て、投稿を承認する

PR の作成者が `backlog-fix-review` で対応して返信したら、同じ URL でもう一度実行してください。修正を確かめて、解決か再指摘を返します。指摘や解決を投稿した後は、PR の説明文の末尾のサマリーも更新します（対応側と同じ内容）。

**対応の記録**: 「この PR のレビューの記録を出して」と頼むと、指摘ごとの対応状況（指摘者・分類・対応内容・コミット・解決日時など）を CSV（Excel で開ける）と Markdown（集計つき）にして、`.review-state/export/` に出力します。Backlog には何も投稿しません（[詳細](references/details.md#作成されるファイル)）。

## レビューの観点

レビューの観点（チェックリスト・規約）は、このスキルの中には持ちません。**対象リポジトリで管理しているドキュメント**（`AGENTS.md`・Steering・レビューガイドなど）を読みます。探し方は [references/guidelines.md](references/guidelines.md) にあります。

## 詳しい情報

| 内容 | 場所 |
|---|---|
| 指摘の書式（対応側が自動修正できる書き方） | [references/finding-guide.md](references/finding-guide.md) |
| レビューの観点をどこから読むか | [references/guidelines.md](references/guidelines.md) |
| 許可設定の例、セキュリティ、作成されるファイル、CLI | [references/details.md](references/details.md) |
| スナップショット（エージェントが読む JSON）の項目 | [references/snapshot.md](references/snapshot.md) |
| エージェントが読む手順書 | [SKILL.md](SKILL.md) |
| 変更履歴 | [CHANGELOG.md](CHANGELOG.md) |
| ライセンス | [LICENSE](LICENSE)（MIT） |
