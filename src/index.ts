#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FreeeClient } from "../lib/freee/client.js";
import { generateAnnualReport, parseMonthlyResult, toMonthlyResult } from "./annual-report.js";
import { parseAuditArgs } from "./cli.js";
import { type AuditRules, parseAuditRules, parseReceiptCheckConfig, parseReceiptRules } from "./config.js";
import { runAudit } from "./runner.js";
import { buildSheetData, sheetDataToCsv } from "./sheets.js";
import type { AnthropicLike } from "./vision.js";

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
    const all = jsonFiles.map((f: string) => parseMonthlyResult(readFileSync(join(jsonDir, f), "utf-8")));
    const annual = generateAnnualReport(cliArgsEarly.fiscalYearLabel, all, {
      fiscalYearStart: cliArgsEarly.fiscalYearStart,
      fiscalYearEnd: cliArgsEarly.fiscalYearEnd,
    });
    const outPath = resolve(cliArgsEarly.outPath);
    writeFileSync(outPath, annual.markdown);
    console.error(`[tax-audit] Annual report written to ${outPath}`);
    console.log(annual.markdown);
    if (annual.overallSeverity === "error") process.exit(2);
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
  let receiptCheck: import("./checks.js").ReceiptCheckConfig | undefined;
  if (existsSync(rulesPath)) {
    const { parse } = await import("yaml");
    const rawReceiptConfig = parse(readFileSync(rulesPath, "utf-8"));
    receiptRules = parseReceiptRules(rawReceiptConfig);
    receiptCheck = parseReceiptCheckConfig(rawReceiptConfig);
  }

  // Load check tuning (foreign vendor list, duplicate check exclusions)
  const auditRulesPath = process.env.AUDIT_RULES_PATH ?? resolve("config/audit-rules.yaml");
  let auditRules: AuditRules = {};
  if (existsSync(auditRulesPath)) {
    const { parse } = await import("yaml");
    auditRules = parseAuditRules(parse(readFileSync(auditRulesPath, "utf-8")));
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
    receiptCheck,
    foreignVendors: auditRules.foreignVendors,
    duplicateOptions: auditRules.duplicateOptions,
    ntaAppId: process.env.NTA_APP_ID,
    enableVision: cliArgs.enableVision,
    visionMaxReceipts: cliArgs.visionMaxReceipts,
    ocrCachePath: resolve(cliArgs.ocrCachePath),
    invoiceCachePath: resolve(cliArgs.invoiceCachePath),
  });

  // Output
  const outPath = resolve(cliArgs.outPath);
  writeFileSync(outPath, report.markdown);
  console.error(`[tax-audit] Report written to ${outPath}`);

  // Save monthly result as JSON for annual aggregation
  if (cliArgs.saveJsonDir) {
    const jsonDir = resolve(cliArgs.saveJsonDir);
    mkdirSync(jsonDir, { recursive: true });
    const monthlyResult = toMonthlyResult(cliArgs.period, results, {
      startDate: cliArgs.startDate,
      endDate: cliArgs.endDate,
      mode: cliArgs.mode,
    });
    const runId = monthlyResult.generatedAt.replace(/[-:]/g, "").slice(0, 15);
    const jsonPath = resolve(jsonDir, `audit-results-${cliArgs.period}-${runId}.json`);
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
  enrichAccountItemNames,
  FALLBACK_DOMESTIC_TAX_CODES,
  normalizeForMatching,
  resolveDomesticTaxCodes,
} from "./checks.js";
export { parseAuditArgs } from "./cli.js";
export { parseAuditRules, parseReceiptCheckConfig, parseReceiptRules } from "./config.js";
export { dealsFilterUrl, walletTxnUrl } from "./freee-links.js";
export { generateReport } from "./report.js";
export { buildDealToWalletTxnMap, ocrDealReceipts, parseSameTransaction, runAudit } from "./runner.js";
export { buildSheetData, sheetDataToCsv } from "./sheets.js";
export { InvoiceCache } from "./invoice-cache.js";
export { checkInvoiceRegistration, extractRegistrationNumber, issuerNameMatches, queryNtaValidity } from "./invoice-check.js";
export { checkReceiptConsistency, ocrReceipt, parseVisionResponse } from "./vision.js";
export { OcrCache } from "./ocr-cache.js";
export { generateAnnualReport, parseMonthlyResult, toMonthlyResult } from "./annual-report.js";
