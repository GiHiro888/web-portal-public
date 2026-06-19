# web-portal

複数アプリ前提のトップページ（ランチャー）＋各アプリのリリースコピーを集約するデプロイ専用フォルダ。

## デプロイ方針（Cloudflare Pages）

このフォルダ自体がリポジトリルート＝デプロイ元。

- Framework preset: None
- Build command: （空欄）
- Build output directory: `/`
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

## git の状態（2026-06-19・ローカルのみ）

- `git init`済み・初回コミット済み（ブランチ`main`）。
- commit author は**プレースホルダー**（`your-github-handle <your-github-handle@users.noreply.github.com>`）。
  **push前に必ず実際のGitHub noreplyメールへ差替えること**：
  ```powershell
  git config user.name  "<実際のハンドルネーム>"
  git config user.email "<ID>+<handle>@users.noreply.github.com"
  git commit --amend --reset-author --no-edit
  ```
- `git remote`は未設定（sandboxからpush不可のため）。push手順は次を参照：
  - 既存の公開リポジトリのルートをこの構成へ置き換える場合 → `works/Expense tracking/web-portal移行_GitHub公開手順_20260619.md`
  - 新規リポジトリとして公開する場合 → `gh repo create <owner>/<repo> --public --source=. --remote=origin && git push -u origin main`

## スコープ外（未着手）

- 実際の`push`（sandboxから不可。ユーザーがPowerShellで実施）
- Cloudflare Pages プロジェクト接続・デプロイ（既存接続を流用する場合は設定変更不要）
- `FEEDBACK_FORM_URL` の実URL差替（`expense/assets/app.js` 内、実URL受領後に対応）
