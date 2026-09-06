import type { FreeeClient } from "../lib/freee/client.js";
import type { Deal, WalletTransaction } from "../lib/freee/types.js";
import {
  type AuditResult,
  checkDuplicateDeals,
  checkReceiptCoverage,
  checkStaleTransactions,
  checkTaxCategory,
  DEFAULT_DUPLICATE_LEVEL,
  type DuplicateCheckOptions,
  enrichAccountItemNames,
  FALLBACK_DOMESTIC_TAX_CODES,
  type ForeignVendor,
  resolveDomesticTaxCodes,
  severityForLevel,
  type ReceiptCheckConfig,
  type ReceiptExemptionRules,
} from "./checks.js";
import { DuplicateCache } from "./duplicate-cache.js";
import { InvoiceCache } from "./invoice-cache.js";
import { type InvoiceEntry, checkInvoiceRegistration, extractRegistrationNumber } from "./invoice-check.js";
import { OcrCache } from "./ocr-cache.js";
import { type AuditReport, generateReport } from "./report.js";
import { type AnthropicLike, checkReceiptConsistency, type DealWithOCR, ocrReceipt, type ReceiptOCR } from "./vision.js";

/** 1 回の実行で新規に OCR する証憑数の既定上限。読了分はキャッシュされ次回に持ち越す。 */
export const DEFAULT_VISION_MAX_RECEIPTS = 20;

/**
 * Fallback vendor list when config/audit-rules.yaml is absent.
 * The maintained list lives in that file so readers can update it without
 * editing TypeScript (see book ch.12 annual maintenance).
 */
export const DEFAULT_FOREIGN_VENDORS: ForeignVendor[] = [
  "aws",
  "github",
  "openai",
  "anthropic",
  "cursor",
  "claude",
  "stripe",
  "gamma",
  "superultra",
  "xai",
  "grok",
  { pattern: "google\\s*cloud", name: "Google Cloud" },
  "azure",
  "vercel",
  "netlify",
];

export interface AuditDeps {
  client: FreeeClient;
  startDate: string;
  endDate: string;
  period: string;
  now?: Date;
  fullCheck?: boolean;
  dupCachePath?: string;
  invoiceCachePath?: string;
  anthropic?: AnthropicLike;
  receiptRules?: ReceiptExemptionRules;
  /** E1 の有効/無効と報告レベル。未指定なら DEFAULT_RECEIPT_CHECK。 */
  receiptCheck?: ReceiptCheckConfig;
  /** E3 の照合対象。未指定なら DEFAULT_FOREIGN_VENDORS。 */
  foreignVendors?: ForeignVendor[];
  /** E5 の除外設定。未指定なら除外なし（従来どおり）。 */
  duplicateOptions?: DuplicateCheckOptions;
  httpClient?: typeof fetch;
  /** 国税庁 Web-API のアプリケーション ID。未設定なら E6 は登録番号を「確認不能」として報告する。 */
  ntaAppId?: string;
  /**
   * E2/E6 の Vision OCR を有効にする。false なら anthropic があっても証憑を外部に送らない。
   * E5 の Vision 精査もこのフラグで制御する。
   */
  enableVision?: boolean;
  /** 1 回の実行で新規に OCR する証憑数の上限。 */
  visionMaxReceipts?: number;
  ocrCachePath?: string;
}

export interface AuditOutput {
  results: AuditResult[];
  report: AuditReport;
  dealToWalletTxnId: Map<number, number>;
}

export async function runAudit(deps: AuditDeps): Promise<AuditOutput> {
  const {
    client,
    startDate,
    endDate,
    period,
    now = new Date(),
    fullCheck = false,
    dupCachePath = "duplicate-check.db",
    anthropic,
  } = deps;

  // Vision (有料・証憑を外部送信) は明示フラグと API クライアントの両方が揃ったときだけ動かす
  const vision = deps.enableVision && anthropic ? anthropic : undefined;
  if (anthropic && !deps.enableVision) {
    console.error("[tax-audit] ANTHROPIC_API_KEY is set but --vision was not given; E2/E5 精査/E6 はスキップ");
  }

  console.error(`[tax-audit] Period: ${startDate} to ${endDate}`);

  // Fetch data
  console.error("[tax-audit] Fetching deals...");
  const deals = await client.listDeals({
    start_issue_date: startDate,
    end_issue_date: endDate,
  });
  console.error(`[tax-audit] ${deals.length} deals`);

  // GET /api/1/deals returns account_item_id only. Without this join every
  // check that keys off the account name (E1 exemptions, E3 matching, E5
  // exclusions) silently sees undefined.
  const accountCategories = new Map<number, string>();
  try {
    console.error("[tax-audit] Fetching account items...");
    const accountItems = await client.listAccountItems();
    enrichAccountItemNames(deals, accountItems);
    for (const item of accountItems) {
      if (item.account_category) accountCategories.set(item.id, item.account_category);
    }
    console.error(`[tax-audit] ${accountItems.length} account items resolved`);
  } catch (err: unknown) {
    console.error(
      `[tax-audit] listAccountItems failed, account-name based rules will not apply: ${err instanceof Error ? err.message : err}`,
    );
  }

  console.error("[tax-audit] Fetching wallet transactions...");
  const txns = await client.listUnregisteredTransactions();
  console.error(`[tax-audit] ${txns.length} unregistered transactions`);

  console.error("[tax-audit] Fetching all wallet transactions for URL mapping...");
  const allWalletTxns = await client.listAllWalletTransactions({
    from_date: startDate,
    to_date: endDate,
  });
  console.error(`[tax-audit] ${allWalletTxns.length} wallet transactions`);

  // Company tax codes for E3 (prefer taxes/companies over hardcoded table)
  let domesticTaxCodes = FALLBACK_DOMESTIC_TAX_CODES;
  let taxCodesUnverified: string | undefined;
  try {
    console.error("[tax-audit] Fetching company tax categories...");
    const taxes = await client.listCompanyTaxes();
    domesticTaxCodes = resolveDomesticTaxCodes(taxes);
    console.error(`[tax-audit] Domestic taxable-purchase codes: ${[...domesticTaxCodes].sort((a, b) => a - b).join(", ")}`);
  } catch (err: unknown) {
    taxCodesUnverified = err instanceof Error ? err.message : String(err);
    console.error(`[tax-audit] listCompanyTaxes failed, using fallback codes: ${taxCodesUnverified}`);
  }

  // Build deal→wallet_txn_id map
  const dealToWalletTxnId = buildDealToWalletTxnMap(deals, allWalletTxns);
  console.error(`[tax-audit] ${dealToWalletTxnId.size} deals mapped to wallet_txns`);

  // Bank/card statement memo per deal. freee expense deals frequently have an
  // empty description, so this is the only text E1/E3/E5 can match on.
  const walletTxnById = new Map(allWalletTxns.map((w) => [w.id, w.description]));
  const walletTxnDescriptions = new Map<number, string>();
  for (const [dealId, wtId] of dealToWalletTxnId) {
    const desc = walletTxnById.get(wtId);
    if (desc) walletTxnDescriptions.set(dealId, desc);
  }

  // Run checks
  // Vision 精査でも同じレベルを使う。Vision も LLM 判定であり「同一取引」を
  // 確定したことにはならないため、検出経路によってレベルを変えない。
  const duplicateLevel = deps.duplicateOptions?.level ?? DEFAULT_DUPLICATE_LEVEL;
  const dupeResult = checkDuplicateDeals(deals, {
    ...deps.duplicateOptions,
    walletTxnDescriptions,
  });

  // Refine duplicate check with Vision API + cache
  const dupCache = new DuplicateCache(dupCachePath);

  if (dupeResult.items.length > 0 && vision) {
    console.error(`[tax-audit] Verifying ${dupeResult.items.length} duplicate candidates...`);
    const dealMap = new Map(deals.map((d) => [d.id, d]));
    const refinedItems: typeof dupeResult.items = [];

    for (const item of dupeResult.items) {
      const ids = item.ids ?? [item.id];

      if (!fullCheck) {
        const cached = dupCache.get(ids);
        if (cached === "separate_txn") {
          console.error(`[tax-audit] Cache hit: ${ids.join(",")} = separate_txn, skipping`);
          continue;
        }
        if (cached === "confirmed_dup") {
          item.level = duplicateLevel;
          item.reason += "（重複確認済み）";
          refinedItems.push(item);
          continue;
        }
      }

      const hasNoReceipt = ids.some((id) => {
        const deal = dealMap.get(id);
        return !deal?.receipts || deal.receipts.length === 0;
      });
      if (hasNoReceipt) {
        item.reason += "（レシート未添付あり）";
        refinedItems.push(item);
        continue;
      }

      // Download receipt PDFs and compare via Vision API
      try {
        const pdfs: Buffer[] = [];
        for (const dealId of ids) {
          const deal = dealMap.get(dealId);
          const receiptId = deal?.receipts?.[0]?.id;
          if (receiptId) {
            const pdf = await client.downloadReceipt(receiptId);
            pdfs.push(pdf);
          }
        }

        if (pdfs.length >= 2) {
          console.error(`[tax-audit] Vision comparing ${ids.join(",")} (${pdfs.length} PDFs)...`);
          const content: Array<
            | { type: "document"; source: { type: "base64"; media_type: string; data: string } }
            | { type: "text"; text: string }
          > = [];
          for (const pdf of pdfs) {
            content.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
            });
          }
          content.push({
            type: "text",
            text: `これらの${pdfs.length}枚のレシート/領収書は同一の取引に対するものですか？
注文番号、商品名、日付、金額を比較して判定してください。
回答は JSON のみ: {"same_transaction": true/false, "reason": "理由"}`,
          });

          const resp = await vision.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 256,
            messages: [{ role: "user", content }],
          });

          const text = resp.content[0]?.type === "text" ? (resp.content[0].text ?? "") : "";
          const verdict = parseSameTransaction(text);

          if (verdict === null) {
            // 判定不能: 候補を残し、既存のキャッシュ判断も上書きしない
            console.error(`[tax-audit] Vision parse failed for ${ids.join(",")}: ${text}`);
            item.reason += "（Vision 判定不能、要確認）";
            refinedItems.push(item);
          } else if (verdict.same) {
            dupCache.set(ids, "confirmed_dup");
            item.level = duplicateLevel;
            item.reason += "（Vision: 同一取引）";
            refinedItems.push(item);
          } else {
            dupCache.set(ids, "separate_txn");
            console.error(`[tax-audit] ${ids.join(",")} confirmed as separate transactions: ${verdict.reason}`);
          }
          continue;
        }
      } catch (err: unknown) {
        console.error(`[tax-audit] Vision comparison failed: ${err instanceof Error ? err.message : err}`);
      }

      // Fallback: metadata comparison
      const metas: string[] = [];
      for (const dealId of ids) {
        const deal = dealMap.get(dealId);
        const receiptId = deal?.receipts?.[0]?.id;
        if (!receiptId) {
          metas.push("none");
          continue;
        }
        try {
          const receipt = await client.getReceipt(receiptId);
          const m = receipt.receipt_metadatum;
          metas.push(`${m?.partner_name ?? ""}|${m?.issue_date ?? ""}|${m?.amount ?? ""}`);
        } catch {
          metas.push("error");
        }
      }
      const uniqueMetas = new Set(metas);
      if (metas.includes("error")) {
        // メタデータ取得に失敗した取引がある: 別取引と確定せず候補を残す
        item.reason += "（メタデータ取得失敗、要確認）";
        refinedItems.push(item);
      } else if (uniqueMetas.size === 1) {
        item.level = duplicateLevel;
        item.reason += "（メタデータ同一、要確認）";
        refinedItems.push(item);
      } else {
        dupCache.set(ids, "separate_txn");
      }
    }

    dupeResult.items = refinedItems;
    dupeResult.severity = refinedItems.length > 0 ? severityForLevel(duplicateLevel) : "pass";
    dupeResult.summary =
      refinedItems.length > 0
        ? `${refinedItems.length} グループの重複取引を検出`
        : "重複取引なし（レシート内容で除外済み）";
  }
  dupCache.close();

  // E2 + E6: OCR every receipt attached to expense deals (opt-in, requires --vision).
  // 読了した証憑は OcrCache に残し、1 回の実行では新規 OCR を上限件数で打ち切る。
  let consistencyResult: AuditResult | undefined;
  let invoiceResult: AuditResult | undefined;
  if (vision) {
    const ocrCache = new OcrCache(deps.ocrCachePath ?? "receipt-ocr.db");
    const invoiceCache = new InvoiceCache(deps.invoiceCachePath ?? "invoice-check.db");
    try {
      const expenseDealsWithReceipts = deals.filter((d) => d.type === "expense" && d.receipts && d.receipts.length > 0);
      const { pairs, newlyRead, skipped } = await ocrDealReceipts(
        vision,
        client,
        expenseDealsWithReceipts,
        ocrCache,
        deps.visionMaxReceipts ?? DEFAULT_VISION_MAX_RECEIPTS,
      );
      console.error(`[tax-audit] OCR: ${newlyRead} receipts read this run, ${skipped} deferred to next run`);

      if (pairs.length > 0) {
        consistencyResult = checkReceiptConsistency(pairs);
        console.error(`[tax-audit] Receipt consistency: ${consistencyResult.severity}`);

        const invoiceEntries: InvoiceEntry[] = [];
        for (const { deal, ocrs, skipped: dealSkipped } of pairs) {
          if (ocrs.length === 0 && dealSkipped > 0) continue; // 未検証: E2 側で件数報告済み
          const readable = ocrs.filter((o): o is ReceiptOCR => o !== null);
          const withNumber = readable.find((o) => o.registration_number);
          const regNumber = withNumber?.registration_number ? extractRegistrationNumber(withNumber.registration_number) : null;
          invoiceEntries.push({
            dealId: deal.id,
            regNumber,
            issueDate: deal.issue_date,
            amount: deal.amount,
            vendorName: (withNumber ?? readable[0])?.vendor ?? null,
            ocrFailed: readable.length === 0,
          });
        }
        if (invoiceEntries.length > 0) {
          invoiceResult = await checkInvoiceRegistration(invoiceEntries, invoiceCache, {
            appId: deps.ntaAppId,
            httpClient: deps.httpClient,
          });
          console.error(`[tax-audit] Invoice check: ${invoiceResult.severity}`);
        }
      }
    } finally {
      invoiceCache.close();
      ocrCache.close();
    }
  }

  const taxResult = checkTaxCategory(
    deals,
    deps.foreignVendors ?? DEFAULT_FOREIGN_VENDORS,
    domesticTaxCodes,
    walletTxnDescriptions,
  );
  if (taxCodesUnverified) {
    // 事業所の税区分一覧を取れていない: 例示コードでの判定は確認不能として扱う
    taxResult.severity = taxResult.severity === "error" ? "error" : "warning";
    taxResult.summary = `${taxResult.summary}（事業所の税区分一覧を取得できず例示コード ${[...FALLBACK_DOMESTIC_TAX_CODES].join(",")} で判定。課対仕入 136 等は未判定: ${taxCodesUnverified}）`;
  }

  const results: AuditResult[] = [
    checkReceiptCoverage(
      deals,
      deps.receiptRules ? { ...deps.receiptRules, walletTxnDescriptions, accountCategories } : undefined,
      deps.receiptCheck,
    ),
    checkStaleTransactions(txns, now),
    dupeResult,
    taxResult,
  ];
  if (consistencyResult) results.push(consistencyResult);
  if (invoiceResult) results.push(invoiceResult);

  const report = generateReport(results, period, dealToWalletTxnId);
  return { results, report, dealToWalletTxnId };
}

/**
 * 取引と口座明細を対応付ける。決済 (payments) の日付・金額・口座で照合し、
 * 入出金区分と口座種別も一致するものだけを候補にする。候補が複数あれば
 * 誤リンクを避けるため未確定（対応付けない）。
 */
export function buildDealToWalletTxnMap(deals: Deal[], walletTxns: WalletTransaction[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const deal of deals) {
    for (const payment of deal.payments ?? []) {
      const candidates = walletTxns.filter(
        (w) =>
          w.walletable_id === payment.from_walletable_id &&
          (!w.walletable_type || !payment.from_walletable_type || w.walletable_type === payment.from_walletable_type) &&
          w.entry_side === deal.type &&
          w.date === payment.date &&
          w.amount === payment.amount,
      );
      if (candidates.length === 1) {
        map.set(deal.id, candidates[0].id);
        break;
      }
      if (candidates.length > 1) {
        console.error(`[tax-audit] deal ${deal.id}: ${candidates.length} statement lines match, left unlinked`);
      }
    }
  }
  return map;
}

/** Vision の重複判定応答を読む。JSON として読めない・boolean でないときは null（判定不能）。 */
export function parseSameTransaction(text: string): { same: boolean; reason: string } | null {
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { same_transaction?: unknown; reason?: unknown };
    if (typeof parsed.same_transaction !== "boolean") return null;
    return { same: parsed.same_transaction, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return null;
  }
}

/**
 * 取引に添付された全証憑を OCR する。読了済みはキャッシュから返し、新規 OCR は
 * maxNew 件で打ち切る。打ち切った分は skipped として取引ごとに数える。
 */
export async function ocrDealReceipts(
  vision: AnthropicLike,
  client: Pick<FreeeClient, "downloadReceipt">,
  deals: Deal[],
  cache: OcrCache,
  maxNew: number,
): Promise<{ pairs: DealWithOCR[]; newlyRead: number; skipped: number }> {
  const pairs: DealWithOCR[] = [];
  let newlyRead = 0;
  let skipped = 0;
  for (const deal of deals) {
    const ocrs: Array<ReceiptOCR | null> = [];
    let dealSkipped = 0;
    for (const receipt of deal.receipts ?? []) {
      const cached = cache.get(receipt.id);
      if (cached?.ocr) {
        ocrs.push(cached.ocr);
        continue;
      }
      if (newlyRead >= maxNew) {
        dealSkipped++;
        continue;
      }
      newlyRead++;
      try {
        const pdf = await client.downloadReceipt(receipt.id);
        console.error(`[tax-audit] OCR receipt ${receipt.id} (deal ${deal.id})`);
        const ocr = await ocrReceipt(vision, pdf);
        if (ocr) cache.set(receipt.id, ocr);
        ocrs.push(ocr);
      } catch (err: unknown) {
        console.error(`[tax-audit] OCR failed for receipt ${receipt.id}: ${err instanceof Error ? err.message : err}`);
        ocrs.push(null);
      }
    }
    skipped += dealSkipped;
    pairs.push({ deal, ocrs, skipped: dealSkipped });
  }
  return { pairs, newlyRead, skipped };
}
