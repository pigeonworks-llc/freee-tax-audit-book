# freeeで備える税務調査リスクマネジメント — 付属コード

書籍「freeeで備える税務調査リスクマネジメント」の付属コードリポジトリです。

## 概要

freee API を使って経理データの品質を自動チェックする仕組みのソースコードです。
6つの自動チェック (E1〜E6) とレポート生成、CI/CD パイプライン定義を含みます。

## チェック一覧

| ID | チェック | 内容 |
|----|---------|------|
| E1 | 証憑の紐付け | 経費取引が freee 上で証憑と紐付いているかを検出（免除ルール対応） |
| E2 | レシート整合性 | Vision API でレシートと取引の金額・日付を照合 |
| E3 | 消費税区分 | 海外ベンダー名 + 国内課税仕入 tax_code の要確認を検出（事業所別税区分 API 利用） |
| E4 | 放置取引 | 未登録明細の長期放置を検出（30日/90日） |
| E5 | 重複取引 | 同一取引の二重計上を検出（Vision 精査） |
| E6 | インボイス登録番号 | 証憑の登録番号を国税庁の公表 API で検証（Vision 精査） |

E2・E6 は Vision API を使うため任意実行です。

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

# 期首月（未指定なら 7）。freee の事業所設定に合わせる
export FISCAL_START_MONTH=1

# Vision チェック（E2, E5, E6）を使う場合
export ANTHROPIC_API_KEY=<Anthropic API Key>

# E2 のレシート PDF 置き場（--vision と併用。未指定だと E2 は実行されない）
export RECEIPT_DIR=./receipts

# 月次結果 JSON の保存先。年次レポート（--annual）の入力になる
export AUDIT_JSON_DIR=./results
```

### freee OAuth トークンの取得

初回のみ、OAuth 認証フローを実行してトークンを取得する必要があります。

```bash
node dist/src/oauth-setup.js
# 表示された URL をブラウザで開いてログイン → 認可コードを貼り付け
```

トークンは `FREEE_TOKEN_PATH` に書き出されます。以降の更新は自動で行われるため、
このコマンドは初回と、リフレッシュトークンが失効したときだけ実行します。

## 実行

```bash
# 当月チェック
node dist/src/index.js report.md

# 会計年度チェック（期首〜当月）
node dist/src/index.js report.md --monthly

# Vision チェック込み
RECEIPT_DIR=./receipts node dist/src/index.js report.md --monthly --vision

# CSV も出力
node dist/src/index.js report.md --monthly --sheets

# キャッシュを無視して重複候補を再検証
node dist/src/index.js report.md --monthly --full-check

# 年次レポート（AUDIT_JSON_DIR の月次 JSON を集約）
AUDIT_JSON_DIR=./results node dist/src/index.js annual-report.md --annual
```

`--monthly` の実行時に `AUDIT_JSON_DIR` を設定しておくと、月次の結果が
`audit-results-<period>.json` として保存されます。年度末に `--annual` を実行すると、
保存された月次 JSON を集約して年次レポートを生成します。

### キャッシュの保存先

重複チェックは `duplicate-check.db`、インボイス登録番号チェックは `invoice-check.db` に
判定結果をキャッシュします。いずれも既定ではカレントディレクトリに作られるため、CI で
ワークスペースが実行ごとに消える環境ではキャッシュが効かず、毎回 Vision API と
国税庁 API を呼び直すことになります。

重複チェックのキャッシュは `DUP_CACHE_PATH` でワークスペース外のパスを指定できます。

```bash
export DUP_CACHE_PATH=$HOME/.cache/tax-audit/duplicate-check.db
```

インボイス登録番号チェックのキャッシュは現状 CLI からパスを指定できないため、
CI で永続化する場合は作業ディレクトリ側をキャッシュ対象にしてください。

## 消費税区分チェック (E3) と税区分コード

E3 は次の組み合わせで動作します。

1. `GET /api/1/deals` — 各明細の `tax_code`
2. `GET /api/1/taxes/companies/{company_id}` — 事業所で使える税区分一覧（**推奨**。`/taxes/codes` は廃止予定）

事業所別 API から名称に「課税仕入」「課対仕入」を含むコード集合を組み立て、海外ベンダー名パターンにマッチした取引がその集合に入っていれば warning とします。API 取得に失敗した場合のみ、フォールバックとして一般的な例示コード（2, 3, 21–23）を使います。

税区分の誤りを確定するチェックではなく、請求主体・事業者向け／消費者向け電気通信利用役務などを人間が確認するための候補抽出です。

## 設定ファイル

### `config/receipt-rules.yaml` — 証憑添付チェック（E1）

このチェックが見るのは「freee 上で取引と証憑が紐付いているか」であって、電子帳簿保存法の保存要件そのものではありません。電子取引データについて法令が求めるのは、データを保存し税務調査等の際に提示・提出できる状態にしておくことです（検索要件は規4①、改ざん防止措置は事務処理規程で足ります）。**freee に証憑を集約する運用を選んだ場合の設定**として扱ってください。

```yaml
receipt_check:
  enabled: true            # false でチェック自体を無効化
  unattached_level: warning  # info / warning / error（既定 warning）

receipt_exemptions:
  zero_amount_threshold: 1
  # 免除は金額ではなく取引の性質で行う
  exempt_account_categories:   # 事業経費でない / 貸借対照表科目
    - "事業主"
  exempt_account_items:        # 領収書が発行されない / 別証憑で管理
    - "旅費交通費"
    - "支払手数料"
  exempt_description_patterns: # 実務上インボイスを保存しないもの
    - "振込手数料"
```

少額特例（税込1万円未満）による一律免除は既定で無効です。少額特例が免除するのは適格請求書の保存要件であって、所得税法・法人税法上の領収書等の保存義務ではないためです。従来どおりの金額免除が必要なら `small_amount_threshold` を設定してください。

### `config/audit-rules.yaml` — 税区分（E3）・重複（E5）

```yaml
foreign_vendors:            # E3 の照合対象。全角・大文字小文字は自動で吸収
  - aws
  - { pattern: 'google\s*cloud', name: Google Cloud }

duplicate_check:
  level: warning            # info / warning / error（既定 warning）
  exclude_account_items:    # 同日に複数発生することが常態の科目
    - "旅費交通費"
  min_amount: 1000          # これ未満は対象外
```

重複は機械的に確定できないため、既定は `error` ではなく `warning` です。同日・同額の取引が2件あることは、二重計上の証拠にも正当な2件の証拠にもなります（カード会社が同額を2回請求している場合など）。Vision API が「同一取引」と判定したケースも同じレベルで報告し、削除の判断は人に委ねます。

ベンダーリストの年次メンテナンスはこのファイルの編集だけで済みます（コードの再ビルドは不要）。

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
