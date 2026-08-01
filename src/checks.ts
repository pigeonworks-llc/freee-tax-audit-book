import type { CompanyTax, Deal, WalletTransaction } from "../lib/freee/types.js";

export interface AuditItem {
  id: number;
  ids?: number[];
  date?: string;
  amount?: number;
  description?: string;
  level?: "info" | "warning" | "error";
  reason?: string;
}

export interface AuditResult {
  check: string;
  severity: "pass" | "warning" | "error";
  summary: string;
  items: AuditItem[];
}

/** Receipt exemption rules for checkReceiptCoverage. */
export interface ReceiptExemptionRules {
  /** 少額特例: threshold in JPY (tax-inclusive). Deals below this are exempt. */
  smallAmountThreshold?: number;
  /** ゼロ円・認証チャージ: deals at or below this amount are exempt. */
  zeroAmountThreshold?: number;
  /** 勘定科目名・明細説明で免除（旅費交通費、支払手数料 等）. */
  exemptAccountItems?: string[];
  /** deal_id → wallet_txn description マップ（銀行明細の説明でもマッチ）. */
  walletTxnDescriptions?: Map<number, string>;
}

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

/** Check if a deal is exempt from receipt requirement. Returns reason or null. */
export function isReceiptExempt(deal: Deal, rules: ReceiptExemptionRules): string | null {
  if (rules.zeroAmountThreshold != null && deal.amount <= rules.zeroAmountThreshold) {
    return `少額（¥${deal.amount}）`;
  }
  if (rules.smallAmountThreshold != null && deal.amount < rules.smallAmountThreshold) {
    return `少額特例（< ¥${rules.smallAmountThreshold.toLocaleString()}）`;
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
  return null;
}

/** E1: Check that all expense deals have at least one receipt attached. */
export function checkReceiptCoverage(deals: Deal[], rules?: ReceiptExemptionRules): AuditResult {
  // Only check expense deals — income (sales/refunds) don't require receipts
  const expenseDeals = deals.filter((d) => d.type === "expense");
  const missing = expenseDeals.filter((d) => !d.receipts || d.receipts.length === 0);

  if (!rules) {
    return {
      check: "receipt_coverage",
      severity: missing.length > 0 ? "error" : "pass",
      summary:
        missing.length > 0
          ? `${missing.length}/${expenseDeals.length} 件の支出取引にレシート未添付`
          : `全 ${expenseDeals.length} 件の支出取引にレシート添付済み`,
      items: missing.map((d) => ({
        id: d.id,
        date: d.issue_date,
        amount: d.amount,
        description: d.details[0]?.description ?? d.details[0]?.account_item_name,
        level: "error" as const,
        reason: "レシート未添付",
      })),
    };
  }

  const items: AuditItem[] = [];
  let exemptCount = 0;

  for (const d of missing) {
    const exemptReason = isReceiptExempt(d, rules);
    if (exemptReason) {
      exemptCount++;
      items.push({
        id: d.id,
        date: d.issue_date,
        amount: d.amount,
        description: d.details[0]?.description ?? d.details[0]?.account_item_name,
        level: "info",
        reason: `レシート免除: ${exemptReason}`,
      });
    } else {
      items.push({
        id: d.id,
        date: d.issue_date,
        amount: d.amount,
        description: d.details[0]?.description ?? d.details[0]?.account_item_name,
        level: "error",
        reason: "レシート未添付",
      });
    }
  }

  const errorCount = missing.length - exemptCount;

  return {
    check: "receipt_coverage",
    severity: errorCount > 0 ? "error" : "pass",
    summary:
      errorCount > 0
        ? `${errorCount}/${expenseDeals.length} 件の支出取引にレシート未添付（${exemptCount} 件免除）`
        : `全 ${expenseDeals.length} 件の支出取引 OK（${exemptCount} 件免除、残り添付済み）`,
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

/** E5: Detect duplicate deals (same date + amount + description). */
export function checkDuplicateDeals(deals: Deal[]): AuditResult {
  const groups = new Map<string, number[]>();

  for (const d of deals) {
    const desc = d.details[0]?.description ?? d.details[0]?.account_item_name ?? "";
    const key = `${d.issue_date}|${d.amount}|${d.type}|${desc}`;
    const ids = groups.get(key) ?? [];
    ids.push(d.id);
    groups.set(key, ids);
  }

  const dupes: AuditItem[] = [];
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    const [date, amount, desc] = key.split("|");
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

  return {
    check: "duplicate_deals",
    severity: dupes.length > 0 ? "error" : "pass",
    summary: dupes.length > 0 ? `${dupes.length} グループの重複取引を検出` : "重複取引なし",
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
  foreignVendorPatterns: string[],
  domesticTaxCodes: Set<number> = FALLBACK_DOMESTIC_TAX_CODES,
): AuditResult {
  const items: AuditItem[] = [];
  const patterns = foreignVendorPatterns.map((p) => new RegExp(p, "i"));

  for (const d of deals) {
    for (const detail of d.details) {
      const text = `${detail.description ?? ""} ${detail.account_item_name}`;
      const isForeign = patterns.some((p) => p.test(text));
      if (isForeign && domesticTaxCodes.has(detail.tax_code)) {
        items.push({
          id: d.id,
          date: d.issue_date,
          amount: detail.amount,
          description: `${detail.description ?? detail.account_item_name} (tax_code=${detail.tax_code})`,
          level: "warning",
          reason:
            "海外サービス名に国内課税仕入の税区分が設定されている（請求主体・課税関係を確認）",
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
