# freeeで実現する 税務調査リスクマネジメント — 付属コード

書籍「freeeで実現する 税務調査リスクマネジメント」の付属コードリポジトリです。

## 概要

freee API を使って経理データの品質を自動チェックする仕組みのソースコードです。
5つの自動チェック (E1〜E5) とレポート生成、CI/CD パイプライン定義を含みます。

## チェック一覧

| ID | チェック | 内容 |
|----|---------|------|
| E1 | レシート添付漏れ | 経費取引のレシート未添付を検出（免除ルール対応） |
| E2 | レシート整合性 | Vision API でレシートと取引の金額・日付を照合 |
| E3 | 消費税区分 | 海外ベンダー名 + 国内課税仕入 tax_code の要確認を検出（事業所別税区分 API 利用） |
| E4 | 放置取引 | 未登録明細の長期放置を検出（30日/90日） |
| E5 | 重複取引 | 同一取引の二重計上を検出（Vision 精査） |

## セットアップ

### 前提条件

- **Node.js 20 または 22（LTS）** — `package.json` の `engines` は `>=20 <23`
  - Node 23+ / 26 では `better-sqlite3` の native ビルドが失敗することがある
- pnpm 9
- freee OAuth アプリケーションの作成（Client ID / Client Secret）

### インストール

```bash
# 推奨: fnm / nvm で Node 22 を指定
# fnm use 22
pnpm install
pnpm build
```

### 依存のメンテ方針（薄い C クラス）

- この repo は書籍付属のサンプルであり、本番 SLI はない
- 依存更新は **Mend Renovate Community Cloud（無料 SaaS）** を想定
  - 設定: `.github/renovate.json`（月次・major 自動 PR なし）
- self-host Renovate / 週次 Dependabot は使わない
- security alert が出たら月次バッチか個別 PR で対応する
### 環境変数

```bash
export FREEE_COMPANY_ID=<事業所ID>
export FREEE_CLIENT_ID=<OAuth Client ID>
export FREEE_CLIENT_SECRET=<OAuth Client Secret>
export FREEE_TOKEN_PATH=~/.config/freee/token.json

# Vision チェック（E2, E5）を使う場合
export ANTHROPIC_API_KEY=<Anthropic API Key>
```

### freee OAuth トークンの取得

初回のみ、OAuth 認証フローを実行してトークンを取得する必要があります。

```bash
node oauth-setup.js
# ブラウザでログイン → 認証コードを入力
```

## 実行

```bash
# 当月チェック
node dist/index.js report.md

# 会計年度チェック（期首〜当月）
node dist/index.js report.md --monthly

# Vision チェック込み
RECEIPT_DIR=./receipts node dist/index.js report.md --monthly --vision

# CSV も出力
node dist/index.js report.md --monthly --sheets
```

## 消費税区分チェック (E3) と税区分コード

E3 は次の組み合わせで動作します。

1. `GET /api/1/deals` — 各明細の `tax_code`
2. `GET /api/1/taxes/companies/{company_id}` — 事業所で使える税区分一覧（**推奨**。`/taxes/codes` は廃止予定）

事業所別 API から名称に「課税仕入」「課対仕入」を含むコード集合を組み立て、海外ベンダー名パターンにマッチした取引がその集合に入っていれば warning とします。API 取得に失敗した場合のみ、フォールバックとして一般的な例示コード（2, 3, 21–23）を使います。

税区分の誤りを確定するチェックではなく、請求主体・事業者向け／消費者向け電気通信利用役務などを人間が確認するための候補抽出です。

## 免除ルールの設定

`config/receipt-rules.yaml` でレシート添付漏れの免除条件を設定できます。

```yaml
receipt_exemptions:
  small_amount_threshold: 10000  # 少額特例（税込1万円未満）
  zero_amount_threshold: 1       # ¥0/¥1 の認証チャージ等
  exempt_account_items:
    - "旅費交通費"    # 公共交通機関特例
    - "支払手数料"    # 銀行振込手数料
    - "役員報酬"      # 給与明細で管理
    # ... 詳細は config/receipt-rules.yaml を参照
```

## スケジュール実行の例

特定の CI 製品に依存しません。書籍第12章の説明に合わせ、次の例を同梱しています。

| パス | 内容 |
|------|------|
| `examples/crontab.example` | 手元マシン / 常時起動ホストの cron 例 |
| `examples/github-actions/tax-audit.yml` | GitHub Actions の月次実行例 |
| `examples/legacy/Jenkinsfile.tax-audit` | 旧 Jenkins 例（参考のみ） |

Secrets やパスは環境に合わせて書き換えてください。

## テスト

```bash
pnpm test
```

## ライセンス

MIT

## 関連

- 書籍: [freeeで備える税務調査リスクマネジメント](https://www.amazon.co.jp/dp/B0GV23G8KF)（Amazon Kindle）
- [freee API リファレンス](https://developer.freee.co.jp/docs/accounting)
- [freee ヘルプセンター](https://support.freee.co.jp/)
