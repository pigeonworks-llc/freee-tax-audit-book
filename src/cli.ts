export type AuditMode = "current-month" | "previous-month" | "fiscal-ytd";

export interface AuditCliArgs {
  startDate: string;
  endDate: string;
  /** 保存名・レポート見出しに使う期間ラベル (2026-08 / FY2025-ytd-2026-08-31 等) */
  period: string;
  mode: AuditMode;
  /** @deprecated mode === "fiscal-ytd" と同義。互換のため残す。 */
  isMonthly: boolean;
  fullCheck: boolean;
  enableVision: boolean;
  visionMaxReceipts: number;
  exportSheets: boolean;
  outPath: string;
  dupCachePath: string;
  ocrCachePath: string;
  invoiceCachePath: string;
  saveJsonDir?: string;
  annualMode: boolean;
  jsonDir?: string;
  /** 年次集約の対象年度 (FY2025 等) と、その期首・期末日 */
  fiscalYearLabel: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
}

/** Fiscal year start month used when FISCAL_START_MONTH is unset. */
export const DEFAULT_FISCAL_START_MONTH = 7;

/** 1 回の実行で新規に OCR する証憑数の既定上限（VISION_MAX_RECEIPTS で変更可）。 */
export const DEFAULT_VISION_MAX_RECEIPTS = 20;

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

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDay(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** 指定日を含む会計年度の期首年を返す（期首月 startMonth）。 */
export function fiscalYearOf(date: Date, startMonth: number): number {
  return date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1;
}

function optionValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const withEq = args.find((a) => a.startsWith(`${name}=`));
  return withEq?.slice(name.length + 1);
}

/**
 * 実行モード:
 *   (既定)      当月 1 日〜実行日
 *   --previous  前月 1 日〜前月末（毎月 1 日の自動実行で前月を締める用途）
 *   --monthly   期首〜実行日の累計（互換。以前の --monthly と同じ範囲）
 *   --from / --to  任意期間 (YYYY-MM-DD)
 */
export function parseAuditArgs(argv?: string[], now?: Date, fiscalStartMonth?: number): AuditCliArgs {
  const args = argv ?? process.argv.slice(2);
  const date = now ?? new Date();
  const startMonth = fiscalStartMonth ?? resolveFiscalStartMonth(process.env.FISCAL_START_MONTH);

  const fullCheck = args.includes("--full-check");
  const enableVision = args.includes("--vision");
  const exportSheets = args.includes("--sheets");
  const annualMode = args.includes("--annual");
  const saveJsonDir = process.env.AUDIT_JSON_DIR;
  const jsonDir = process.env.AUDIT_JSON_DIR;

  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const fiscalYear = fiscalYearOf(date, startMonth);
  const fiscalYearStart = ymd(fiscalYear, startMonth, 1);
  const fyEndMonth = startMonth === 1 ? 12 : startMonth - 1;
  const fyEndYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
  const fiscalYearEnd = ymd(fyEndYear, fyEndMonth, lastDay(fyEndYear, fyEndMonth));

  let mode: AuditMode;
  let startDate: string;
  let endDate: string;
  let period: string;
  const from = optionValue(args, "--from");
  const to = optionValue(args, "--to");
  if (from || to) {
    mode = "current-month";
    startDate = from ?? ymd(y, m, 1);
    endDate = to ?? ymd(y, m, date.getDate());
    period = `${startDate}_${endDate}`;
  } else if (args.includes("--previous")) {
    mode = "previous-month";
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    startDate = ymd(py, pm, 1);
    endDate = ymd(py, pm, lastDay(py, pm));
    period = `${py}-${String(pm).padStart(2, "0")}`;
  } else if (args.includes("--monthly")) {
    mode = "fiscal-ytd";
    startDate = fiscalYearStart;
    endDate = ymd(y, m, date.getDate());
    period = `FY${fiscalYear}-ytd-${endDate}`;
  } else {
    mode = "current-month";
    startDate = ymd(y, m, 1);
    endDate = ymd(y, m, date.getDate());
    period = `${y}-${String(m).padStart(2, "0")}`;
  }

  // 年次集約の対象年度: --fiscal-year FY2025 / 2025 で指定、無ければ「前期」を既定にする
  // （年度末直後に実行する用途。当期を集約したいなら明示指定）
  const fyArg = optionValue(args, "--fiscal-year")?.replace(/^FY/i, "");
  const annualFy = fyArg ? Number(fyArg) : fiscalYear - 1;
  const annualStart = ymd(annualFy, startMonth, 1);
  const annualEndYear = startMonth === 1 ? annualFy : annualFy + 1;
  const annualEnd = ymd(annualEndYear, fyEndMonth, lastDay(annualEndYear, fyEndMonth));

  const dupCachePath = process.env.DUP_CACHE_PATH ?? "duplicate-check.db";
  const ocrCachePath = process.env.OCR_CACHE_PATH ?? "receipt-ocr.db";
  const invoiceCachePath = process.env.INVOICE_CACHE_PATH ?? "invoice-check.db";
  const maxRaw = Number(process.env.VISION_MAX_RECEIPTS);
  const visionMaxReceipts = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_VISION_MAX_RECEIPTS;

  const valueOpts = new Set(["--from", "--to", "--fiscal-year"]);
  const outPath =
    args.find((a, i) => !a.startsWith("--") && !(i > 0 && valueOpts.has(args[i - 1]))) ??
    (annualMode ? `tax-audit-annual-FY${annualFy}.md` : `tax-audit-${period}.md`);

  return {
    startDate,
    endDate,
    period,
    mode,
    isMonthly: mode === "fiscal-ytd",
    fullCheck,
    enableVision,
    visionMaxReceipts,
    exportSheets,
    outPath,
    dupCachePath,
    ocrCachePath,
    invoiceCachePath,
    saveJsonDir,
    annualMode,
    jsonDir,
    fiscalYearLabel: `FY${annualFy}`,
    fiscalYearStart: annualStart,
    fiscalYearEnd: annualEnd,
  };
}
