# web-portal

複数アプリ前提のトップページ（ランチャー）＋各アプリのリリースコピーを集約するデプロイ専用フォルダ。

## デプロイ方針（Cloudflare Pages）

- Framework preset: None
- Build command: （空欄）
- Build output directory: `web-portal/`
- 環境変数: なし

## 構成

```
web-portal/
├─ index.html          # ランチャー（トップページ）
├─ assets/styles.css    # ランチャー用スタイル
├─ expense/             # 個人経費管理システム（リリースコピー）
└─ README.md
```

## `expense/` はリリースコピー

`expense/` の中身は `works/Expense tracking/expense-tracker/` のコピーであり、**直接編集しない**。

開発は常に `works/Expense tracking/expense-tracker/` 側で行い、検証完了後に以下の手順でこのフォルダへ反映する。

## リリース更新手順

1. `works/Expense tracking/expense-tracker/` で開発・検証を完了する。
2. 中身一式を `web-portal/expense/` へ再コピーする。
3. `diff -r "works/Expense tracking/expense-tracker" "works/web-portal/expense"` で差分なしを確認する。
4. `web-portal/index.html` のバージョンタグ（`v_NNN`）・最終更新日（ヘッダー右上）を更新する。
5. ステータスバッジ（`.badge-live` / `.badge-dev`）を必要に応じて切替える。

## スコープ外（このフォルダの作成時点では未着手）

- `git init` / `.gitignore` / 初回コミット
- GitHubリポジトリ作成・push
- Cloudflare Pages プロジェクト接続・デプロイ
- `FEEDBACK_FORM_URL` の実URL差替（`expense/assets/app.js` 内、実URL受領後に対応）
