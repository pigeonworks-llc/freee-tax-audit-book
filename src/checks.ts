import type { AccountItem, CompanyTax, Deal, WalletTransaction } from "../lib/freee/types.js";

export interface AuditItem {
  id: number;
  ids?: number[];
  date?: string;
  amount?: number;
  description?: string;
  level?: "info" | "warning" | "error";
  reason?: string;
  /** E3: 判定のきっかけになった海外ベンダー名（本文 第7章の「実行結果の読み方」に対応）。 */
  matchedVendor?: string;
}

export interface AuditResult {
  check: string;
  severity: "pass" | "warning" | "error";
  summary: string;
  items: AuditItem[];
}

/** Receipt exemption rules for checkReceiptCoverage. */
export interface ReceiptExemptionRules {
  /**
   * 少額特例: threshold in JPY (tax-inclusive). Deals below this are exempt.
   *
   * 少額特例が免除するのは適格請求書の保存要件であって、所得税法・法人税法上の
   * 領収書等の保存義務ではない。金額だけを理由に一律免除すると本来確認すべき
   * 取引まで対象外になるため、既定の設定ファイルでは無効にしている。
   */
  smallAmountThreshold?: number;
  /** ゼロ円・認証チャージ: deals at or below this amount are exempt. */
  zeroAmountThreshold?: number;
  /** 勘定科目名・明細説明で免除（旅費交通費、支払手数料 等）. */
  exemptAccountItems?: string[];
  /**
   * 勘定科目カテゴリで免除。事業経費でないもの（事業主貸・事業主借）や
   * 貸借対照表科目など、証憑の性質自体が異なる取引を区分で外す。
   * account_item_id → account_category のマップを渡す。
   */
  exemptAccountCategories?: string[];
  /** account_item_id → account_category（exemptAccountCategories の判定に使う）. */
  accountCategories?: Map<number, string>;
  /** 摘要に含まれていたら免除する文字列（振込手数料・納付書 等）. */
  exemptDescriptionPatterns?: string[];
  /** deal_id → wallet_txn description マップ（銀行明細の説明でもマッチ）. */
  walletTxnDescriptions?: Map<number, string>;
}

/** How checkReceiptCoverage reports a deal with no receipt attached. */
export interface ReceiptCheckConfig {
  /**
   * false にすると E1 を実行しない。
   *
   * 電子取引データについて法令が求めるのはデータを保存し調査時に提示できる
   * ことであって、freee 上で取引と紐付けることではない（規4①・規4③、
   * 電子帳簿保存法一問一答【電子取引関係】問45・問46）。したがってこの
   * チェックは freee に証憑を集約する運用を選んだ事業者向けの設定であり、
   * 未添付は法令違反を意味しない。
   */
  enabled: boolean;
  /** 未添付をどのレベルで報告するか。既定は warning（error ではない）。 */
  unattachedLevel: "info" | "warning" | "error";
}

export const DEFAULT_RECEIPT_CHECK: ReceiptCheckConfig = {
  enabled: true,
  unattachedLevel: "warning",
};

/** Convert half-width katakana to full-width for matching bank statement descriptions. */
function halfToFullKana(s: string): string {
  const map: Record<string, string> = {
    ｱ: "ア",
    ｲ: "イ",
    ｳ: "ウ",
    ｴ: "エ",
    ｵ: "オ",
    ｶ: "カ",
    ｷ: "キ",
    ｸ: "ク",
    ｹ: "ケ",
    ｺ: "コ",
    ｻ: "サ",
    ｼ: "シ",
    ｽ: "ス",
    ｾ: "セ",
    ｿ: "ソ",
    ﾀ: "タ",
    ﾁ: "チ",
    ﾂ: "ツ",
    ﾃ: "テ",
    ﾄ: "ト",
    ﾅ: "ナ",
    ﾆ: "ニ",
    ﾇ: "ヌ",
    ﾈ: "ネ",
    ﾉ: "ノ",
    ﾊ: "ハ",
    ﾋ: "ヒ",
    ﾌ: "フ",
    ﾍ: "ヘ",
    ﾎ: "ホ",
    ﾏ: "マ",
    ﾐ: "ミ",
    ﾑ: "ム",
    ﾒ: "メ",
    ﾓ: "モ",
    ﾔ: "ヤ",
    ﾕ: "ユ",
    ﾖ: "ヨ",
    ﾗ: "ラ",
    ﾘ: "リ",
    ﾙ: "ル",
    ﾚ: "レ",
    ﾛ: "ロ",
    ﾜ: "ワ",
    ｦ: "ヲ",
    ﾝ: "ン",
    ﾞ: "゛",
    ﾟ: "゜",
    ｰ: "ー",
  };
  // Handle dakuten/handakuten combinations
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (map[ch]) {
      const base = map[ch];
      if (next === "ﾞ" && "カキクケコサシスセソタチツテトハヒフヘホ".includes(base)) {
        result += String.fromCharCode(base.charCodeAt(0) + 1);
        i++;
      } else if (next === "ﾟ" && "ハヒフヘホ".includes(base)) {
        result += String.fromCharCode(base.charCodeAt(0) + 2);
        i++;
      } else {
        result += base;
      }
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Normalize text for vendor / description matching.
 *
 * NFKC folds full-width alphanumerics to half-width, so bank statements that
 * record `ＰａｙＰａｌ決済` or `ＡＭＡＺＯＮ` match the same patterns as their
 * half-width form. Lower-casing makes the comparison case-insensitive without
 * relying on regex flags.
 *
 * Kept separate from halfToFullKana(): E1 matches Japanese account names in
 * half-width katakana, where NFKC would change existing behaviour.
 */
export function normalizeForMatching(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * Fill in `account_item_name` on deal details from the account item master.
 *
 * GET /api/1/deals returns only `account_item_id`, so every check that reads
 * `account_item_name` sees undefined unless the names are joined in first.
 * Mutates and returns the given deals.
 */
export function enrichAccountItemNames(deals: Deal[], accountItems: AccountItem[]): Deal[] {
  const idToName = new Map(accountItems.map((a) => [a.id, a.name]));
  for (const deal of deals) {
    for (const det of deal.details) {
      if (!det.account_item_name) {
        det.account_item_name = idToName.get(det.account_item_id);
      }
    }
  }
  return deals;
}

/** Check if a deal is exempt from receipt requirement. Returns reason or null. */
export function isReceiptExempt(deal: Deal, rules: ReceiptExemptionRules): string | null {
  if (rules.zeroAmountThreshold != null && deal.amount <= rules.zeroAmountThreshold) {
    return `少額（¥${deal.amount}）`;
  }
  if (rules.smallAmountThreshold != null && deal.amount < rules.smallAmountThreshold) {
    return `少額特例（< ¥${rules.smallAmountThreshold.toLocaleString()}）`;
  }
  if (rules.exemptAccountCategories?.length && rules.accountCategories) {
    for (const det of deal.details) {
      const category = rules.accountCategories.get(det.account_item_id);
      if (category && rules.exemptAccountCategories.includes(category)) {
        return `科目区分免除（${category}）`;
      }
    }
  }

  if (rules.exemptAccountItems) {
    // Check account_item_name and description across all details
    for (const det of deal.details) {
      const name = det.account_item_name;
      if (name && rules.exemptAccountItems.includes(name)) {
        return `勘定科目免除（${name}）`;
      }
      const desc = det.description;
      if (desc) {
        const match = rules.exemptAccountItems.find((item) => desc.includes(item));
        if (match) {
          return `明細免除（${match}）`;
        }
      }
    }
    // Check wallet_txn description (bank statement memo, often half-width katakana)
    const wtDesc = rules.walletTxnDescriptions?.get(deal.id);
    if (wtDesc) {
      const fullDesc = halfToFullKana(wtDesc);
      const match = rules.exemptAccountItems.find((item) => wtDesc.includes(item) || fullDesc.includes(item));
      if (match) {
        return `銀行明細免除（${match}）`;
      }
    }
  }

  if (rules.exemptDescriptionPatterns?.length) {
    const texts = deal.details.map((det) => det.description ?? "");
    const wtDesc = rules.walletTxnDescriptions?.get(deal.id);
    if (wtDesc) texts.push(wtDesc, halfToFullKana(wtDesc));
    for (const pattern of rules.exemptDescriptionPatterns) {
      if (texts.some((t) => t.includes(pattern))) {
        return `摘要免除（${pattern}）`;
      }
    }
  }

  return null;
}

/**
 * E1: Check that all expense deals have at least one receipt attached.
 *
 * This measures whether deals and their evidence are linked **inside freee**,
 * which is an operational choice, not a legal requirement — see
 * ReceiptCheckConfig. `config` controls whether the check runs at all and how
 * unattached deals are reported.
 */
export function checkReceiptCoverage(
  deals: Deal[],
  rules?: ReceiptExemptionRules,
  config: ReceiptCheckConfig = DEFAULT_RECEIPT_CHECK,
): AuditResult {
  if (!config.enabled) {
    return {
      check: "receipt_coverage",
      severity: "pass",
      summary: "証憑添付チェックは無効（freee への証憑集約を採用する場合に有効化）",
      items: [],
    };
  }

  const level = config.unattachedLevel;
  // Only check expense deals — income (sales/refunds) don't require receipts
  const expenseDeals = deals.filter((d) => d.type === "expense");
  const missing = expenseDeals.filter((d) => !d.receipts || d.receipts.length === 0);
  const severityForLevel = level === "info" ? "pass" : level;

  if (!rules) {
    return {
      check: "receipt_coverage",
      severity: missing.length > 0 ? severityForLevel : "pass",
      summary:
        missing.length > 0
          ? `${missing.length}/${expenseDeals.length} 件の支出取引が freee 上で証憑と未紐付け`
          : `全 ${expenseDeals.length} 件の支出取引に証憑が紐付け済み`,
      items: missing.map((d) => ({
        id: d.id,
        date: d.issue_date,
        amount: d.amount,
        description: d.details[0]?.description ?? d.details[0]?.account_item_name,
        level,
        reason: "freee 上で証憑と未紐付け",
      })),
    };
  }

  const items: AuditItem[] = [];
  let exemptCount = 0;

  for (const d of missing) {
    const exemptReason = isReceiptExempt(d, rules);
    const description = d.details[0]?.description ?? d.details[0]?.account_item_name;
    if (exemptReason) {
      exemptCount++;
      items.push({
        id: d.id,
        date: d.issue_date,
        amount: d.amount,
        description,
        level: "info",
        reason: `チェック対象外: ${exemptReason}`,
      });
    } else {
      items.push({
        id: d.id,
        date: d.issue_date,
        amount: d.amount,
        description,
        level,
        reason: "freee 上で証憑と未紐付け",
      });
    }
  }

  const unattachedCount = missing.length - exemptCount;

  return {
    check: "receipt_coverage",
    severity: unattachedCount > 0 ? severityForLevel : "pass",
    summary:
      unattachedCount > 0
        ? `${unattachedCount}/${expenseDeals.length} 件の支出取引が freee 上で証憑と未紐付け（${exemptCount} 件対象外）`
        : `全 ${expenseDeals.length} 件の支出取引 OK（${exemptCount} 件対象外、残り紐付け済み）`,
    items,
  };
}

const STALE_WARNING_DAYS = 30;
const STALE_ERROR_DAYS = 90;

/** E4: Check for unregistered transactions older than thresholds. */
export function checkStaleTransactions(txns: WalletTransaction[], now: Date = new Date()): AuditResult {
  const items: AuditItem[] = [];

  for (const txn of txns) {
    if (txn.status !== 1) continue; // only unregistered
    const txnDate = new Date(txn.date);
    const days = Math.floor((now.getTime() - txnDate.getTime()) / 86_400_000);

    if (days >= STALE_ERROR_DAYS) {
      items.push({
        id: txn.id,
        date: txn.date,
        amount: txn.amount,
        description: txn.description,
        level: "error",
        reason: `${days}日放置（90日超）`,
      });
    } else if (days >= STALE_WARNING_DAYS) {
      items.push({
        id: txn.id,
        date: txn.date,
        amount: txn.amount,
        description: txn.description,
        level: "warning",
        reason: `${days}日放置（30日超）`,
      });
    }
  }

  const hasError = items.some((i) => i.level === "error");
  return {
    check: "stale_transactions",
    severity: items.length === 0 ? "pass" : hasError ? "error" : "warning",
    summary: items.length === 0 ? "放置された未登録取引なし" : `${items.length} 件の未登録取引が長期放置`,
    items,
  };
}

/** Tuning for checkDuplicateDeals. All fields are optional; defaults keep the plain behaviour. */
export interface DuplicateCheckOptions {
  /**
   * 同日に複数発生することが常態の勘定科目（旅費交通費・支払手数料 等）を対象外にする。
   * enrichAccountItemNames() で科目名が補完されていることが前提。
   */
  excludeAccountItems?: string[];
  /** この金額未満の取引は対象外にする。少額の交通費・手数料の偽陽性を抑える。 */
  minAmount?: number;
  /** deal_id → wallet_txn description。取引の説明が空でも銀行明細の摘要で別取引を判別する。 */
  walletTxnDescriptions?: Map<number, string>;
}

/**
 * E5: Detect duplicate deals (same date + amount + description).
 *
 * The grouping key also uses the bank statement memo and the partner, because
 * freee expense deals routinely carry neither a description nor a partner:
 * without them, "same day, same amount" alone groups unrelated transit fares
 * and transfer fees together. The partner is only part of the key when *both*
 * deals have one, so adding partners cannot hide a real duplicate.
 */
export function checkDuplicateDeals(deals: Deal[], options: DuplicateCheckOptions = {}): AuditResult {
  const { excludeAccountItems, minAmount, walletTxnDescriptions } = options;
  const groups = new Map<string, number[]>();
  let excludedCount = 0;

  for (const d of deals) {
    if (minAmount != null && d.amount < minAmount) {
      excludedCount++;
      continue;
    }
    if (excludeAccountItems?.length) {
      const hit = d.details.some((det) => det.account_item_name && excludeAccountItems.includes(det.account_item_name));
      if (hit) {
        excludedCount++;
        continue;
      }
    }

    const rawDesc = d.details[0]?.description ?? walletTxnDescriptions?.get(d.id) ?? d.details[0]?.account_item_name ?? "";
    const desc = normalizeForMatching(rawDesc);
    // partner は両方に設定されている場合だけ効かせる（片方だけなら従来どおり日付+金額+摘要で判定）
    const partner = d.partner_id ?? "";
    const key = `${d.issue_date}|${d.amount}|${d.type}|${desc}|${partner}`;
    const ids = groups.get(key) ?? [];
    ids.push(d.id);
    groups.set(key, ids);
  }

  const dupes: AuditItem[] = [];
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    const [date, amount, , desc] = key.split("|");
    dupes.push({
      id: ids[0],
      ids,
      date,
      amount: Number(amount),
      description: desc,
      level: "error",
      reason: `${ids.length} 件の重複（ID: ${ids.join(", ")}）`,
    });
  }

  const excludedNote = excludedCount > 0 ? `（${excludedCount} 件を除外設定によりスキップ）` : "";

  return {
    check: "duplicate_deals",
    severity: dupes.length > 0 ? "error" : "pass",
    summary:
      dupes.length > 0
        ? `${dupes.length} グループの重複取引を検出${excludedNote}`
        : `重複取引なし${excludedNote}`,
    items: dupes,
  };
}

/**
 * Fallback domestic taxable-purchase codes when company tax list is unavailable.
 * These are **examples** only; prefer resolveDomesticTaxCodes() from
 * GET /api/1/taxes/companies/{company_id}.
 */
export const FALLBACK_DOMESTIC_TAX_CODES = new Set([
  2, // 課税仕入（税率不明）
  3, // 課税仕入（税率不明）
  21, // 課税仕入 10%
  22, // 課税仕入 8%（軽減）
  23, // 課税仕入 8%（経過措置）
]);

/**
 * Build the set of tax_code values that mean "通常の国内課税仕入" for this company.
 * Uses the company tax list from GET /api/1/taxes/companies/{company_id}.
 *
 * Matching is name-based (課税仕入 / 課対仕入) so code numbers can differ by company.
 * Falls back to FALLBACK_DOMESTIC_TAX_CODES if no matching names are found.
 */
export function resolveDomesticTaxCodes(taxes: CompanyTax[]): Set<number> {
  const codes = new Set<number>();
  for (const t of taxes) {
    const name = `${t.name_ja ?? ""} ${t.name}`;
    // freee UI/API may use 課税仕入 or 課対仕入; exclude sales-side codes
    if (/(課税?仕入|課対仕入)/.test(name) && !/売上/.test(name)) {
      codes.add(t.code);
    }
  }
  if (codes.size === 0) {
    return new Set(FALLBACK_DOMESTIC_TAX_CODES);
  }
  return codes;
}

/**
 * Foreign vendor entry for E3.
 *
 * A bare string is the regex itself (kept for backwards compatibility); the
 * object form lets `config/audit-rules.yaml` give a readable display name for
 * a pattern like `google\s*cloud`.
 */
export type ForeignVendor = string | { pattern: string; name?: string };

/**
 * E3: Flag deals whose description matches foreign vendor patterns but use a
 * domestic taxable-purchase tax_code. This does **not** assert a tax error —
 * it surfaces candidates that need human review of the service provider and
 * reverse-charge / consumer telecom rules (see book ch.7).
 *
 * @param domesticTaxCodes Prefer resolveDomesticTaxCodes(listCompanyTaxes()).
 *   Defaults to FALLBACK_DOMESTIC_TAX_CODES for unit tests / offline use.
 */
export function checkTaxCategory(
  deals: Deal[],
  foreignVendorPatterns: ForeignVendor[],
  domesticTaxCodes: Set<number> = FALLBACK_DOMESTIC_TAX_CODES,
  walletTxnDescriptions?: Map<number, string>,
): AuditResult {
  const items: AuditItem[] = [];
  const patterns = foreignVendorPatterns.map((v) => {
    const pattern = typeof v === "string" ? v : v.pattern;
    const label = typeof v === "string" ? v : (v.name ?? v.pattern);
    return { label, re: new RegExp(normalizeForMatching(pattern), "i") };
  });

  for (const d of deals) {
    // 銀行・カード明細の摘要にしかベンダー名が現れない取引が多いため、判定材料に加える
    const walletDesc = walletTxnDescriptions?.get(d.id) ?? "";
    for (const detail of d.details) {
      const text = normalizeForMatching(
        `${detail.description ?? ""} ${detail.account_item_name ?? ""} ${walletDesc}`,
      );
      const matched = patterns.find((p) => p.re.test(text));
      if (matched && domesticTaxCodes.has(detail.tax_code)) {
        const label = detail.description ?? detail.account_item_name ?? walletDesc;
        items.push({
          id: d.id,
          date: d.issue_date,
          amount: detail.amount,
          description: `${label} (tax_code=${detail.tax_code})`,
          level: "warning",
          matchedVendor: matched.label,
          reason: `海外サービス名（${matched.label}）に国内課税仕入の税区分が設定されている（請求主体・課税関係を確認）`,
        });
      }
    }
  }

  return {
    check: "tax_category",
    severity: items.length > 0 ? "warning" : "pass",
    summary: items.length > 0 ? `${items.length} 件の消費税区分に要確認` : "消費税区分の問題なし",
    items,
  };
}
