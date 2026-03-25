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
}

export function parseAuditArgs(argv?: string[], now?: Date): AuditCliArgs {
  const args = argv ?? process.argv.slice(2);
  const date = now ?? new Date();

  const isMonthly = args.includes("--monthly");
  const fullCheck = args.includes("--full-check");
  const enableVision = args.includes("--vision");
  const exportSheets = args.includes("--sheets");

  // Fiscal year starts July 1
  const fiscalYearStart = date.getMonth() >= 6 ? `${date.getFullYear()}-07-01` : `${date.getFullYear() - 1}-07-01`;

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
  };
}
