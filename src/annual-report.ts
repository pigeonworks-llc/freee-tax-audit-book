import type { AuditItem } from "./checks.js";

export interface MonthlyResult {
  period: string;
  generatedAt: string;
  /** 対象期間（省略時は period から推定できる範囲のみ扱う） */
  startDate?: string;
  endDate?: string;
  mode?: string;
  overallSeverity: "pass" | "warning" | "error";
  checks: Array<{
    check: string;
    severity: "pass" | "warning" | "error";
    summary?: string;
    itemCount: number;
    /** 指摘の明細。年次で「何が指摘されたか」を再確認できるように保存する。 */
    items?: AuditItem[];
  }>;
}

export interface AnnualReport {
  fiscalYear: string;
  overallSeverity: "pass" | "warning" | "error";
  months: MonthlyResult[];
  /** 会計年度の各月が対象期間で覆われているか。欠落があれば年次合格は出さない。 */
  coverage: { covered: string[]; missing: string[] };
  markdown: string;
}

export interface AnnualOptions {
  /** 会計年度の期首日・期末日 (YYYY-MM-DD)。指定時のみ網羅性を検証する。 */
  fiscalYearStart?: string;
  fiscalYearEnd?: string;
}

const SEVERITY_ICON: Record<string, string> = { pass: "✓", warning: "!", error: "✗" };

/** Parse a JSON string into a MonthlyResult. */
export function parseMonthlyResult(json: string): MonthlyResult {
  return JSON.parse(json) as MonthlyResult;
}

/** Convert an AuditResult[] to a MonthlyResult for storage. */
export function toMonthlyResult(
  period: string,
  results: Array<{ check: string; severity: "pass" | "warning" | "error"; summary?: string; items: AuditItem[] }>,
  range?: { startDate: string; endDate: string; mode?: string },
): MonthlyResult {
  const overallSeverity = results.some((r) => r.severity === "error")
    ? "error"
    : results.some((r) => r.severity === "warning")
      ? "warning"
      : "pass";

  return {
    period,
    generatedAt: new Date().toISOString(),
    startDate: range?.startDate,
    endDate: range?.endDate,
    mode: range?.mode,
    overallSeverity,
    checks: results.map((r) => ({
      check: r.check,
      severity: r.severity,
      summary: r.summary,
      itemCount: r.items.length,
      items: r.items,
    })),
  };
}

/** 月 (YYYY-MM) の一覧を start〜end の範囲で列挙する。 */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.slice(0, 7).split("-").map(Number);
  const [ey, em] = end.slice(0, 7).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** 月次結果が対象とする月の一覧。startDate/endDate が無い旧形式は period から推定する。 */
function monthsOf(r: MonthlyResult): string[] {
  if (r.startDate && r.endDate) return monthsBetween(r.startDate, r.endDate);
  if (/^\d{4}-\d{2}$/.test(r.period)) return [r.period];
  return [];
}

/**
 * Generate an annual report by aggregating monthly results.
 * 対象年度外の結果は除外し、同じ月に複数の結果があれば最新 (generatedAt) を採用する。
 */
export function generateAnnualReport(fiscalYear: string, results: MonthlyResult[], options: AnnualOptions = {}): AnnualReport {
  const fyMonths =
    options.fiscalYearStart && options.fiscalYearEnd ? monthsBetween(options.fiscalYearStart, options.fiscalYearEnd) : null;

  // 年度内の結果だけを残し、月ごとに最新を選ぶ
  const inScope = results.filter((r) => {
    const ms = monthsOf(r);
    return fyMonths ? ms.some((m) => fyMonths.includes(m)) : true;
  });
  const latestByKey = new Map<string, MonthlyResult>();
  for (const r of inScope) {
    const key = `${r.startDate ?? ""}|${r.endDate ?? ""}|${r.period}`;
    const prev = latestByKey.get(key);
    if (!prev || prev.generatedAt < r.generatedAt) latestByKey.set(key, r);
  }
  const months = [...latestByKey.values()].sort((a, b) => (a.startDate ?? a.period).localeCompare(b.startDate ?? b.period));

  const covered = new Set<string>();
  for (const r of months) for (const m of monthsOf(r)) if (!fyMonths || fyMonths.includes(m)) covered.add(m);
  const missing = fyMonths ? fyMonths.filter((m) => !covered.has(m)) : [];
  const coverage = { covered: [...covered].sort(), missing };

  let overallSeverity: "pass" | "warning" | "error" = months.some((m) => m.overallSeverity === "error")
    ? "error"
    : months.some((m) => m.overallSeverity === "warning")
      ? "warning"
      : "pass";
  if (missing.length > 0 && overallSeverity === "pass") overallSeverity = "warning";

  const markdown = renderMarkdown(fiscalYear, months, overallSeverity, coverage, fyMonths);
  return { fiscalYear, overallSeverity, months, coverage, markdown };
}

function renderMarkdown(
  fiscalYear: string,
  months: MonthlyResult[],
  overallSeverity: "pass" | "warning" | "error",
  coverage: { covered: string[]; missing: string[] },
  fyMonths: string[] | null,
): string {
  const lines: string[] = [];
  lines.push(`# 年次監査レポート - ${fiscalYear}`);
  lines.push("");
  lines.push(`総合結果: ${SEVERITY_ICON[overallSeverity]} ${overallSeverity}`);
  lines.push("");
  if (fyMonths) {
    lines.push(`対象月: ${fyMonths.length} か月中 ${coverage.covered.length} か月分の結果あり`);
    if (coverage.missing.length > 0) {
      lines.push(`**結果が無い月: ${coverage.missing.join(", ")}** — 年間の確認は完了していません。`);
    }
    lines.push("");
  }

  if (months.length === 0) {
    lines.push("月次データがありません。");
    return lines.join("\n");
  }

  lines.push("## 集約した実行結果");
  lines.push("");
  lines.push("| 期間 | 実行日時 | 判定 |");
  lines.push("|------|----------|------|");
  for (const m of months) {
    const range = m.startDate && m.endDate ? `${m.startDate} 〜 ${m.endDate}` : m.period;
    lines.push(`| ${range} | ${m.generatedAt.slice(0, 19)} | ${SEVERITY_ICON[m.overallSeverity]} ${m.overallSeverity} |`);
  }
  lines.push("");

  const checkNames = [...new Set(months.flatMap((m) => m.checks.map((c) => c.check)))];
  lines.push("## チェック別結果");
  lines.push("");
  const labels = months.map((m) => m.period);
  lines.push(`| チェック | ${labels.join(" | ")} |`);
  lines.push(`|---------|${labels.map(() => "---").join("|")}|`);
  for (const check of checkNames) {
    const cells = months.map((m) => {
      const c = m.checks.find((ch) => ch.check === check);
      if (!c) return "未実施";
      return SEVERITY_ICON[c.severity] ?? c.severity;
    });
    lines.push(`| ${check} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  // 未実施チェック（ある期間には存在するが別の期間に無い）
  const notRun = months.flatMap((m) => checkNames.filter((c) => !m.checks.some((ch) => ch.check === c)).map((c) => `${m.period}: ${c}`));
  if (notRun.length > 0) {
    lines.push("## 未実施のチェック");
    lines.push("");
    for (const n of notRun) lines.push(`- ${n}`);
    lines.push("");
  }

  const issueMonths = months.filter((m) => m.overallSeverity !== "pass");
  if (issueMonths.length > 0) {
    lines.push("## 問題が検出された期間");
    lines.push("");
    for (const m of issueMonths) {
      for (const c of m.checks.filter((c) => c.severity !== "pass")) {
        lines.push(`- **${m.period}** ${SEVERITY_ICON[c.severity]} ${c.check}: ${c.itemCount} 件${c.summary ? ` — ${c.summary}` : ""}`);
        for (const item of (c.items ?? []).slice(0, 20)) {
          const ids = item.ids ?? [item.id];
          lines.push(`  - ${ids.join(",")} ${item.date ?? ""} ${item.amount?.toLocaleString() ?? ""} ${item.reason ?? ""}`);
        }
        if ((c.items?.length ?? 0) > 20) lines.push(`  - …他 ${(c.items?.length ?? 0) - 20} 件（月次 JSON を参照）`);
      }
    }
    lines.push("");
  } else if (coverage.missing.length === 0) {
    lines.push("## 結果");
    lines.push("");
    lines.push("年間を通じてすべてのチェックが問題なく通過しました。");
    lines.push("");
  }

  return lines.join("\n");
}
