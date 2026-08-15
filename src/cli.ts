export interface AuditCliArgs {
  startDate: string;
  endDate: string;
  period: string;
  isMonthly: boolean;
  fullCheck: boolean;
  enableVision: boolean;
  receiptDir?: string;
  exportSheets: boolean;
  outPath: string;
  dupCachePath: string;
  saveJsonDir?: string;
  annualMode: boolean;
  jsonDir?: string;
}

/** Fiscal year start month used when FISCAL_START_MONTH is unset. */
export const DEFAULT_FISCAL_START_MONTH = 7;

/**
 * Read the fiscal year start month (1-12) from the environment.
 * Anything out of range falls back to the default with a warning, so a typo
 * cannot silently shift the audit period.
 */
export function resolveFiscalStartMonth(raw: string | undefined): number {
  if (raw == null || raw === "") return DEFAULT_FISCAL_START_MONTH;
  const month = Number(raw);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    console.error(
      `[tax-audit] FISCAL_START_MONTH="${raw}" is not a month between 1 and 12; using ${DEFAULT_FISCAL_START_MONTH}`,
    );
    return DEFAULT_FISCAL_START_MONTH;
  }
  return month;
}

export function parseAuditArgs(argv?: string[], now?: Date, fiscalStartMonth?: number): AuditCliArgs {
  const args = argv ?? process.argv.slice(2);
  const date = now ?? new Date();
  const startMonth = fiscalStartMonth ?? resolveFiscalStartMonth(process.env.FISCAL_START_MONTH);

  const isMonthly = args.includes("--monthly");
  const fullCheck = args.includes("--full-check");
  const enableVision = args.includes("--vision");
  const exportSheets = args.includes("--sheets");
  const annualMode = args.includes("--annual");
  const saveJsonDir = process.env.AUDIT_JSON_DIR;
  const jsonDir = process.env.AUDIT_JSON_DIR;

  // freee の事業所設定の期首月に合わせる。December-start 等も同じ式で成り立つ。
  const fiscalYear = date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1;
  const fiscalYearStart = `${fiscalYear}-${String(startMonth).padStart(2, "0")}-01`;

  const startDate = isMonthly
    ? fiscalYearStart
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const period = isMonthly
    ? `FY${fiscalYearStart.slice(0, 4)}`
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  const receiptDir = process.env.RECEIPT_DIR;
  const dupCachePath = process.env.DUP_CACHE_PATH ?? "duplicate-check.db";

  const outPath = args.find((a) => !a.startsWith("--")) ?? `tax-audit-${period}.md`;

  return {
    startDate,
    endDate,
    period,
    isMonthly,
    fullCheck,
    enableVision: enableVision && !!receiptDir,
    receiptDir,
    exportSheets,
    outPath,
    dupCachePath,
    saveJsonDir,
    annualMode,
    jsonDir,
  };
}
