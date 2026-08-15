import type { FreeeClient } from "../lib/freee/client.js";
import {
  type AuditResult,
  checkDuplicateDeals,
  checkReceiptCoverage,
  checkStaleTransactions,
  checkTaxCategory,
  type DuplicateCheckOptions,
  enrichAccountItemNames,
  FALLBACK_DOMESTIC_TAX_CODES,
  type ForeignVendor,
  resolveDomesticTaxCodes,
  type ReceiptCheckConfig,
  type ReceiptExemptionRules,
} from "./checks.js";
import { DuplicateCache } from "./duplicate-cache.js";
import { InvoiceCache } from "./invoice-cache.js";
import { type InvoiceEntry, checkInvoiceRegistration, extractRegistrationNumber } from "./invoice-check.js";
import { type AuditReport, generateReport } from "./report.js";
import { type AnthropicLike, ocrReceipt } from "./vision.js";

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
  try {
    console.error("[tax-audit] Fetching company tax categories...");
    const taxes = await client.listCompanyTaxes();
    domesticTaxCodes = resolveDomesticTaxCodes(taxes);
    console.error(`[tax-audit] Domestic taxable-purchase codes: ${[...domesticTaxCodes].sort((a, b) => a - b).join(", ")}`);
  } catch (err: unknown) {
    console.error(
      `[tax-audit] listCompanyTaxes failed, using fallback codes: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Build deal→wallet_txn_id map
  const dealToWalletTxnId = new Map<number, number>();
  for (const deal of deals) {
    const payment = deal.payments?.[0];
    if (!payment) continue;
    const match = allWalletTxns.find(
      (w) => w.date === deal.issue_date && w.amount === deal.amount && w.walletable_id === payment.from_walletable_id,
    );
    if (match) dealToWalletTxnId.set(deal.id, match.id);
  }
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
  const dupeResult = checkDuplicateDeals(deals, {
    ...deps.duplicateOptions,
    walletTxnDescriptions,
  });

  // Refine duplicate check with Vision API + cache
  const dupCache = new DuplicateCache(dupCachePath);

  if (dupeResult.items.length > 0 && anthropic) {
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
          item.level = "error";
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

          const resp = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 256,
            messages: [{ role: "user", content }],
          });

          const text = resp.content[0].type === "text" ? (resp.content[0].text ?? "") : "";
          let isSame = false;
          try {
            const jsonMatch = /\{[\s\S]*\}/.exec(text);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as { same_transaction: boolean; reason: string };
              isSame = parsed.same_transaction;
              console.error(`[tax-audit] Vision result: ${isSame ? "SAME" : "DIFFERENT"} - ${parsed.reason}`);
            }
          } catch {
            console.error(`[tax-audit] Vision parse failed: ${text}`);
          }

          if (isSame) {
            dupCache.set(ids, "confirmed_dup");
            item.level = "error";
            item.reason += "（Vision: 同一取引）";
            refinedItems.push(item);
          } else {
            dupCache.set(ids, "separate_txn");
            console.error(`[tax-audit] ${ids.join(",")} confirmed as separate transactions`);
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
      if (uniqueMetas.size === 1) {
        item.level = "warning";
        item.reason += "（メタデータ同一、要確認）";
        refinedItems.push(item);
      } else {
        dupCache.set(ids, "separate_txn");
      }
    }

    dupeResult.items = refinedItems;
    dupeResult.severity =
      refinedItems.length > 0 ? (refinedItems.some((i) => i.level === "error") ? "error" : "warning") : "pass";
    dupeResult.summary =
      refinedItems.length > 0
        ? `${refinedItems.length} グループの重複取引を検出`
        : "重複取引なし（レシート内容で除外済み）";
  }
  dupCache.close();

  // E6: Invoice registration number check (opt-in, requires Vision API)
  let invoiceResult: AuditResult | undefined;
  if (anthropic) {
    const invoiceCachePath = deps.invoiceCachePath ?? "invoice-check.db";
    const invoiceCache = new InvoiceCache(invoiceCachePath);
    try {
      console.error("[tax-audit] Running invoice registration check...");
      const expenseDealsWithReceipts = deals.filter(
        (d) => d.type === "expense" && d.receipts && d.receipts.length > 0,
      );

      const invoiceEntries: InvoiceEntry[] = [];
      for (const deal of expenseDealsWithReceipts.slice(0, 20)) {
        const receiptId = deal.receipts?.[0]?.id;
        if (!receiptId) continue;

        try {
          const pdf = await client.downloadReceipt(receiptId);
          console.error(`[tax-audit] OCR invoice: deal ${deal.id}`);
          const ocr = await ocrReceipt(anthropic, pdf);
          const regNumber = ocr?.registration_number
            ? extractRegistrationNumber(ocr.registration_number)
            : null;
          invoiceEntries.push({
            dealId: deal.id,
            regNumber,
            issueDate: deal.issue_date,
            amount: deal.amount,
          });
        } catch (err: unknown) {
          console.error(`[tax-audit] OCR failed for deal ${deal.id}: ${err instanceof Error ? err.message : err}`);
          invoiceEntries.push({
            dealId: deal.id,
            regNumber: null,
            issueDate: deal.issue_date,
            amount: deal.amount,
          });
        }
      }

      if (invoiceEntries.length > 0) {
        invoiceResult = await checkInvoiceRegistration(invoiceEntries, invoiceCache, deps.httpClient);
        console.error(`[tax-audit] Invoice check: ${invoiceResult.severity}`);
      }
    } finally {
      invoiceCache.close();
    }
  }

  const results: AuditResult[] = [
    checkReceiptCoverage(
      deals,
      deps.receiptRules ? { ...deps.receiptRules, walletTxnDescriptions, accountCategories } : undefined,
      deps.receiptCheck,
    ),
    checkStaleTransactions(txns, now),
    dupeResult,
    checkTaxCategory(
      deals,
      deps.foreignVendors ?? DEFAULT_FOREIGN_VENDORS,
      domesticTaxCodes,
      walletTxnDescriptions,
    ),
  ];

  if (invoiceResult) {
    results.push(invoiceResult);
  }

  const report = generateReport(results, period, dealToWalletTxnId);
  return { results, report, dealToWalletTxnId };
}
