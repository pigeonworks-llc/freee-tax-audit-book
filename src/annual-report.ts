export interface MonthlyResult {
  period: string;
  generatedAt: string;
  overallSeverity: "pass" | "warning" | "error";
  checks: Array<{
    check: string;
    severity: "pass" | "warning" | "error";
    itemCount: number;
  }>;
}

export interface AnnualReport {
  fiscalYear: string;
  overallSeverity: "pass" | "warning" | "error";
  months: MonthlyResult[];
  markdown: string;
}

const SEVERITY_ICON: Record<string, string> = {
  pass: "✓",
  warning: "!",
  error: "✗",
};

/** Parse a JSON string into a MonthlyResult. */
export function parseMonthlyResult(json: string): MonthlyResult {
  return JSON.parse(json) as MonthlyResult;
}

/** Convert an AuditResult[] to a MonthlyResult for storage. */
export function toMonthlyResult(
  period: string,
  results: Array<{ check: string; severity: "pass" | "warning" | "error"; items: Array<unknown> }>,
): MonthlyResult {
  const overallSeverity = results.some((r) => r.severity === "error")
    ? "error"
    : results.some((r) => r.severity === "warning")
      ? "warning"
      : "pass";

  return {
    period,
    generatedAt: new Date().toISOString(),
    overallSeverity,
    checks: results.map((r) => ({
      check: r.check,
      severity: r.severity,
      itemCount: r.items.length,
    })),
  };
}

/** Generate an annual report by aggregating monthly results. */
export function generateAnnualReport(fiscalYear: string, months: MonthlyResult[]): AnnualReport {
  const overallSeverity: "pass" | "warning" | "error" = months.some((m) => m.overallSeverity === "error")
    ? "error"
    : months.some((m) => m.overallSeverity === "warning")
      ? "warning"
      : "pass";

  const markdown = renderMarkdown(fiscalYear, months, overallSeverity);

  return { fiscalYear, overallSeverity, months, markdown };
}

function renderMarkdown(
  fiscalYear: string,
  months: MonthlyResult[],
  overallSeverity: "pass" | "warning" | "error",
): string {
  const lines: string[] = [];

  lines.push(`# 年次監査レポート - ${fiscalYear}`);
  lines.push("");
  lines.push(`総合結果: ${SEVERITY_ICON[overallSeverity]} ${overallSeverity}`);
  lines.push("");

  if (months.length === 0) {
    lines.push("月次データがありません。");
    return lines.join("\n");
  }

  // Collect all unique check names
  const checkNames = [...new Set(months.flatMap((m) => m.checks.map((c) => c.check)))];

  // Monthly result table
  lines.push("## チェック別月次結果");
  lines.push("");

  const monthLabels = months.map((m) => m.period.slice(5)); // "07", "08", ...
  lines.push(`| チェック | ${monthLabels.join(" | ")} |`);
  lines.push(`|---------|${monthLabels.map(() => "---").join("|")}|`);

  for (const check of checkNames) {
    const cells = months.map((m) => {
      const c = m.checks.find((ch) => ch.check === check);
      if (!c) return "-";
      return SEVERITY_ICON[c.severity] ?? c.severity;
    });
    lines.push(`| ${check} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  // Issues summary
  const issueMonths = months.filter((m) => m.overallSeverity !== "pass");
  if (issueMonths.length > 0) {
    lines.push("## 問題が検出された月");
    lines.push("");

    for (const m of issueMonths) {
      const failedChecks = m.checks.filter((c) => c.severity !== "pass");
      for (const c of failedChecks) {
        lines.push(`- **${m.period}** ${SEVERITY_ICON[c.severity]} ${c.check}: ${c.itemCount} 件`);
      }
    }
    lines.push("");
  } else {
    lines.push("## 結果");
    lines.push("");
    lines.push("年間を通じてすべてのチェックが問題なく通過しました。");
    lines.push("");
  }

  return lines.join("\n");
}
