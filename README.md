# web-portal

複数アプリ前提のトップページ（ランチャー）＋各アプリのリリースコピーを集約するデプロイ専用フォルダ。

## デプロイ方針（Cloudflare Pages）

このフォルダ自体がリポジトリルート＝デプロイ元。

- Framework preset: None
- Build command: （空欄）
- Build output directory: `/`
- 環境変数: なし

## 公開ドメイン

`taskhum.cc`（Cloudflare Pagesのカスタムドメイン設定が必要・ダッシュボード側でユーザーが実施。リポジトリ内にCNAME等のファイルは不要）。

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

**注記（2026-06-21）**：デプロイ／分割版（`expense-tracker/` → `expense/`）はランチャー統合要素（「← ツール一覧へ」戻る導線・「連携ツール（予定機能）」枠）を含む。標準単体版 `works/Expense tracking/個人経費管理システム20260612_065.html`（スタンドアロン配布）はこれらを含まず、**意図的に分岐**している（戻るボタンはランチャー文脈専用で単体版に戻り先が無いため）。

### デプロイ版ファイル命名規則

`expense/` 配下のエントリHTMLは `task_expense_yyyymmdd_0x.html` 形式（`_0x` は2桁の連番、最大 `_99`）。日付はリリース日。`assets/` 配下は連番なしで上書きコピー。

## リリース更新手順

1. `works/Expense tracking/expense-tracker/` で開発・検証を完了する。
2. `assets/` 一式を `web-portal/expense/assets/` へ上書きコピーする。`index.html` は `web-portal/expense/task_expense_{リリース日yyyymmdd}_{連番2桁}.html` として新規コピーする。
3. `diff` で `expense-tracker/index.html` と新しい `task_expense_*.html` の内容が一致すること、`diff -r` で両 `assets/` が一致することを確認する。
4. 確認後、旧い `task_expense_*.html`（前回リリース分）を削除する。
5. `web-portal/index.html` を更新する：
   - バージョンタグ：公開版表記 `Ver.X.Y`（開発内連番 `_0NN` とは別管理）・最終更新日（ヘッダー右上）
   - `href="expense/..."`（主ボタン「Go Tool →」1箇所）を新しい `task_expense_*.html` のファイル名へ更新
6. ステータスバッジ（`.badge-live` / `.badge-dev`）を必要に応じて切替える。
7. 連番運用：**公開（push）前**は同一リリース日内の上書き可（ファイル名・連番を変えず再コピー）。**公開後**は新しい変更点ごとに連番をインクリメントし、旧ファイルは手順4で削除する。

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
- Cloudflare Pagesカスタムドメイン（`taskhum.cc`）の割当・DNS設定（ダッシュボード側・ユーザーが実施）
