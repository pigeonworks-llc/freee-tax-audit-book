# freeeで備える税務調査リスクマネジメント — 付属コード

書籍「freeeで備える税務調査リスクマネジメント」の付属コードリポジトリです。

## 概要

freee API を使って経理データの品質を自動チェックする仕組みのソースコードです。
6つの自動チェック (E1〜E6) とレポート生成、CI/CD パイプライン定義を含みます。

## チェック一覧

| ID | チェック | 内容 |
|----|---------|------|
| E1 | 証憑の紐付け | 経費取引が freee 上で証憑と紐付いているかを検出（免除ルール対応） |
| E2 | レシート整合性 | freee に添付された証憑を Vision API で読み、取引の金額・日付と照合 |
| E3 | 消費税区分 | 海外ベンダー名 + 国内課税仕入 tax_code の要確認を検出（事業所別税区分 API 利用） |
| E4 | 放置取引 | 未登録明細の取引日からの長期放置を検出（30日以上 warning / 90日以上 error） |
| E5 | 重複取引 | 同一取引の二重計上候補を検出（`--vision` 時は証憑で精査） |
| E6 | インボイス登録番号 | 証憑の登録番号を国税庁 Web-API で取引日時点の登録状況・公表名称と照合 |

E2・E6 と E5 の証憑精査は `--vision` を付けたときだけ動きます（`ANTHROPIC_API_KEY` があるだけでは
証憑を外部に送りません）。各チェックは **合格 / 要確認 / 不一致 / 読取失敗 / 未検証** を区別し、
確認できていない件数はレポートの summary に出ます。「問題なし」は検証済みの範囲についてだけ言います。

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

# E6 で国税庁 Web-API を呼ぶ場合（未設定だと登録番号のある取引は「確認不能」として warning）
# アプリケーション ID は国税庁に申請して発行を受ける: https://www.invoice-kohyo.nta.go.jp/web-api/index.html
export NTA_APP_ID=<国税庁 Web-API アプリケーション ID>

# 1 回の実行で新規に OCR する証憑数の上限（既定 20）。読了分はキャッシュされ、次回は残りから続く
export VISION_MAX_RECEIPTS=20

# 月次結果 JSON の保存先。年次レポート（--annual）の入力になる
export AUDIT_JSON_DIR=./results

# 判定キャッシュの保存先（既定はカレントディレクトリ）
export DUP_CACHE_PATH=$HOME/.cache/tax-audit/duplicate-check.db
export OCR_CACHE_PATH=$HOME/.cache/tax-audit/receipt-ocr.db
export INVOICE_CACHE_PATH=$HOME/.cache/tax-audit/invoice-check.db
```

### freee OAuth トークンの取得

初回のみ、OAuth 認証フローを実行してトークンを取得する必要があります。

```bash
node dist/src/oauth-setup.js
# 表示された URL をブラウザで開いてログイン → 認可コードを貼り付け
```

トークンは `FREEE_TOKEN_PATH` に書き出されます。以降の更新は自動で行われるため、
このコマンドは初回と、リフレッシュトークンが失効したときだけ実行します。

freee は更新のたびに refresh_token を回転させます。更新後のトークンは `FREEE_TOKEN_PATH` に
書き戻されるので、**CI など使い捨て環境ではこのファイルを実行後に永続化してください**。
初回の値を毎回 Secret から書き出す運用だと、2 回目の更新で認証に失敗します。
`examples/github-actions/tax-audit.yml` は状態リポジトリに書き戻す例です。
`token.json` は `.gitignore` 済みですが、コミット対象に含めないよう注意してください。

## 実行

```bash
# 当月チェック（当月 1 日〜実行日）
node dist/src/index.js report.md

# 前月を締める（毎月 1 日の自動実行向け。期首の 1 日に実行しても前期末の月が対象になる）
node dist/src/index.js report.md --previous

# 期首から実行日までの累計
node dist/src/index.js report.md --monthly

# 任意期間
node dist/src/index.js report.md --from 2025-10-01 --to 2025-12-31

# Vision チェック込み（E2 / E6 と E5 の証憑精査）
node dist/src/index.js report.md --previous --vision

# CSV も出力
node dist/src/index.js report.md --previous --sheets

# キャッシュを無視して重複候補を再検証
node dist/src/index.js report.md --previous --full-check

# 年次レポート（AUDIT_JSON_DIR の結果 JSON を集約。既定は前期、--fiscal-year で指定）
AUDIT_JSON_DIR=./results node dist/src/index.js annual-report.md --annual --fiscal-year FY2025
```

終了コードは `0` = 指摘なし、`2` = error レベルの指摘あり、`1` = 実行失敗です。
自動実行では 2 と 1 を区別して扱ってください（`examples/` を参照）。

`AUDIT_JSON_DIR` を設定しておくと、実行ごとの結果が
`audit-results-<period>-<実行日時>.json` として保存されます（同じ期間を再実行しても
上書きされません）。JSON には対象期間・実行日時・各チェックの指摘明細が入ります。
`--annual` は対象年度の期間に含まれる結果だけを集約し、同じ期間に複数の結果があれば
最新を採用します。**年度のいずれかの月に結果が無い場合、年次の合格は出しません**
（結果が無い月と、実施されなかったチェックがレポートに列挙されます）。

### Vision OCR の件数上限とキャッシュ

E2 / E6 は取引に添付されたすべての証憑を freee API からダウンロードして OCR します。
1 回の実行で新規に OCR する件数は `VISION_MAX_RECEIPTS`（既定 20）で打ち切られますが、
読了した証憑は `OCR_CACHE_PATH` の SQLite に残るため、次回の実行は残りから続きます。
上限で読まなかった取引は「未検証」として件数がレポートに出ます。

### キャッシュの保存先

重複判定は `duplicate-check.db`、証憑 OCR は `receipt-ocr.db`、登録番号の照会結果は
`invoice-check.db` に保存されます。いずれも既定ではカレントディレクトリに作られるため、CI で
ワークスペースが実行ごとに消える環境では `DUP_CACHE_PATH` / `OCR_CACHE_PATH` /
`INVOICE_CACHE_PATH` でワークスペース外に置き、実行をまたいで永続化してください。
登録番号の照会結果は「登録番号 × 取引日」ごとに 90 日間保持します。

## インボイス登録番号チェック (E6)

証憑から読み取った登録番号 (T + 13 桁) を、国税庁 適格請求書発行事業者公表システムの
Web-API「登録番号と日付を指定して情報を取得する機能」(`/1/valid`) で照会します。
取引日を基準日にするため、登録前や失効・取消後の取引を区別できます。
判定根拠（登録日・失効日・取消日）はレポートに出ます。

- 利用にはアプリケーション ID (`NTA_APP_ID`) が必要です。未設定のときは登録番号のある
  取引を「確認不能」の warning として報告し、合格にはしません。
- 証憑の発行者名と公表名称が一致しないときは、屋号・表記揺れの可能性があるため
  「要確認」の warning にします。
- このチェックは登録番号の有効性の確認であり、個々の支出の仕入税額控除の可否を
  確定するものではありません。

## 消費税区分チェック (E3) と税区分コード

E3 は次の組み合わせで動作します。

1. `GET /api/1/deals` — 各明細の `tax_code`
2. `GET /api/1/taxes/companies/{company_id}` — 事業所で使える税区分一覧（**推奨**。`/taxes/codes` は廃止予定）

事業所別 API から名称に「課税仕入」「課対仕入」「共対仕入」を含むコード集合（非対仕入・輸入・売上側は除く）を組み立て、海外ベンダー名パターンにマッチした取引がその集合に入っていれば warning とします。API 取得に失敗した場合は、freee 公式の税区分コード（課対仕入10% = 136、共対仕入10% = 138 等）と旧コードの例示集合で判定したうえで、E3 全体を「確認不能」の warning として報告します。

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

Secrets やパスは環境に合わせて書き換えてください。いずれの例も、**実行失敗 (exit 1) と
error 指摘 (exit 2) を区別**し、更新後のトークン・判定キャッシュ・結果 JSON を実行をまたいで
保存する形にしています。

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
