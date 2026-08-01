#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FreeeClient } from "../lib/freee/client.js";
import { generateAnnualReport, parseMonthlyResult, toMonthlyResult } from "./annual-report.js";
import { parseAuditArgs } from "./cli.js";
import { runAudit } from "./runner.js";
import { buildSheetData, sheetDataToCsv } from "./sheets.js";
import { type AnthropicLike, checkReceiptConsistency, type DealWithOCR, ocrReceipt } from "./vision.js";

async function main() {
  const cliArgsEarly = parseAuditArgs();

  // Annual report mode: aggregate monthly JSON files
  if (cliArgsEarly.annualMode) {
    const jsonDir = resolve(cliArgsEarly.jsonDir ?? ".");
    if (!existsSync(jsonDir)) {
      console.error(`[tax-audit] JSON directory not found: ${jsonDir}`);
      process.exit(1);
    }
    const jsonFiles = readdirSync(jsonDir)
      .filter((f: string) => f.startsWith("audit-results-") && f.endsWith(".json"))
      .sort();
    if (jsonFiles.length === 0) {
      console.error(`[tax-audit] No monthly result files found in ${jsonDir}`);
      process.exit(1);
    }
    const months = jsonFiles.map((f: string) => parseMonthlyResult(readFileSync(join(jsonDir, f), "utf-8")));
    const annual = generateAnnualReport(cliArgsEarly.period, months);
    const outPath = resolve(cliArgsEarly.outPath);
    writeFileSync(outPath, annual.markdown);
    console.error(`[tax-audit] Annual report written to ${outPath}`);
    console.log(annual.markdown);
    return;
  }

  const companyId = Number(process.env.FREEE_COMPANY_ID);
  if (!companyId) {
    console.error("FREEE_COMPANY_ID is required");
    process.exit(1);
  }

  const client = new FreeeClient({
    apiUrl: process.env.FREEE_API_URL ?? "https://api.freee.co.jp",
    companyId,
    tokenPath: process.env.FREEE_TOKEN_PATH,
    clientId: process.env.FREEE_CLIENT_ID,
    clientSecret: process.env.FREEE_CLIENT_SECRET,
  });

  const cliArgs = cliArgsEarly;

  // Build Anthropic client if API key available
  let anthropic: AnthropicLike | undefined;
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    anthropic = new Anthropic() as unknown as AnthropicLike;
  }

  // Load receipt exemption rules
  const rulesPath = process.env.RECEIPT_RULES_PATH ?? resolve("config/receipt-rules.yaml");
  let receiptRules: import("./checks.js").ReceiptExemptionRules | undefined;
  if (existsSync(rulesPath)) {
    const { parse } = await import("yaml");
    const raw = parse(readFileSync(rulesPath, "utf-8")) as {
      receipt_exemptions?: {
        small_amount_threshold?: number;
        zero_amount_threshold?: number;
        exempt_account_items?: string[];
      };
    };
    if (raw.receipt_exemptions) {
      receiptRules = {
        smallAmountThreshold: raw.receipt_exemptions.small_amount_threshold,
        zeroAmountThreshold: raw.receipt_exemptions.zero_amount_threshold,
        exemptAccountItems: raw.receipt_exemptions.exempt_account_items,
      };
    }
  }

  const { results, report, dealToWalletTxnId } = await runAudit({
    client,
    startDate: cliArgs.startDate,
    endDate: cliArgs.endDate,
    period: cliArgs.period,
    fullCheck: cliArgs.fullCheck,
    dupCachePath: resolve(cliArgs.dupCachePath),
    anthropic,
    receiptRules,
  });

  // E2: Vision-based receipt consistency (opt-in)
  if (cliArgs.enableVision && cliArgs.receiptDir && anthropic) {
    console.error("[tax-audit] Running Vision-based receipt consistency check...");
    const pdfFiles = readdirSync(cliArgs.receiptDir)
      .filter((f: string) => f.endsWith(".pdf"))
      .map((f: string) => join(cliArgs.receiptDir!, f));

    const deals = await client.listDeals({
      start_issue_date: cliArgs.startDate,
      end_issue_date: cliArgs.endDate,
    });
    const pairs: DealWithOCR[] = [];
    const dealsWithReceipts = deals.filter((d) => d.receipts && d.receipts.length > 0);
    const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})_([^_]+)_(\d+)\.pdf$/;

    for (const deal of dealsWithReceipts.slice(0, 20)) {
      const matchingPdf = pdfFiles.find((f: string) => {
        const match = FILENAME_RE.exec(f.split("/").pop() ?? "");
        if (!match) return false;
        return match[1] === deal.issue_date && Number(match[3]) === deal.amount;
      });

      if (matchingPdf) {
        try {
          console.error(`[tax-audit] OCR: ${matchingPdf.split("/").pop()}`);
          const { readFileSync } = await import("node:fs");
          const pdfContent = Buffer.from(readFileSync(matchingPdf));
          const ocr = await ocrReceipt(anthropic, pdfContent);
          pairs.push({ deal, ocr });
        } catch (err: unknown) {
          console.error(`[tax-audit] OCR failed: ${err instanceof Error ? err.message : err}`);
          pairs.push({ deal, ocr: null });
        }
      }
    }

    if (pairs.length > 0) {
      console.error(`[tax-audit] ${pairs.length} receipts OCR'd`);
      results.push(checkReceiptConsistency(pairs));
    }
  }

  // Output
  const outPath = resolve(cliArgs.outPath);
  writeFileSync(outPath, report.markdown);
  console.error(`[tax-audit] Report written to ${outPath}`);

  // Save monthly result as JSON for annual aggregation
  if (cliArgs.saveJsonDir) {
    const jsonDir = resolve(cliArgs.saveJsonDir);
    mkdirSync(jsonDir, { recursive: true });
    const monthlyResult = toMonthlyResult(cliArgs.period, results);
    const jsonPath = resolve(jsonDir, `audit-results-${cliArgs.period}.json`);
    writeFileSync(jsonPath, JSON.stringify(monthlyResult, null, 2));
    console.error(`[tax-audit] JSON written: ${jsonPath}`);
  }

  if (cliArgs.exportSheets) {
    const sheetData = buildSheetData(results, cliArgs.period, dealToWalletTxnId);
    const csvMap = sheetDataToCsv(sheetData);
    const outDir = resolve(outPath, "..");
    for (const [name, csv] of csvMap) {
      const csvPath = resolve(outDir, `tax-audit-${cliArgs.period}-${name}.csv`);
      writeFileSync(csvPath, csv);
      console.error(`[tax-audit] CSV written: ${csvPath}`);
    }
  }

  console.log(report.markdown);
  if (report.overallSeverity === "error") process.exit(2);
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  main().catch((err) => {
    console.error("[tax-audit] Fatal:", err);
    process.exit(1);
  });
}

export {
  checkDuplicateDeals,
  checkReceiptCoverage,
  checkStaleTransactions,
  checkTaxCategory,
  FALLBACK_DOMESTIC_TAX_CODES,
  resolveDomesticTaxCodes,
} from "./checks.js";
export { parseAuditArgs } from "./cli.js";
export { generateReport } from "./report.js";
export { runAudit } from "./runner.js";
export { buildSheetData, sheetDataToCsv } from "./sheets.js";
export { InvoiceCache } from "./invoice-cache.js";
export { checkInvoiceRegistration, extractRegistrationNumber, queryNtaApi } from "./invoice-check.js";
export { checkReceiptConsistency, ocrReceipt } from "./vision.js";
export { generateAnnualReport, parseMonthlyResult, toMonthlyResult } from "./annual-report.js";
