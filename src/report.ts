import type { AuditResult } from "./checks.js";

export interface AuditReport {
  period: string;
  generatedAt: string;
  overallSeverity: "pass" | "warning" | "error";
  results: AuditResult[];
  markdown: string;
}

const SEVERITY_ORDER = { pass: 0, warning: 1, error: 2 } as const;
const SEVERITY_ICON = { pass: "✓", warning: "!", error: "✗" } as const;

export function generateReport(results: AuditResult[], period: string): AuditReport {
  const worst = results.reduce<"pass" | "warning" | "error">(
    (acc, r) => (SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[acc] ? r.severity : acc),
    "pass",
  );

  const lines: string[] = [];
  lines.push(`# 税務監査レポート ${period}`);
  lines.push("");
  lines.push(`生成日時: ${new Date().toISOString().slice(0, 19)}`);
  lines.push(`総合判定: ${SEVERITY_ICON[worst]} ${worst}`);
  lines.push("");

  // Summary table
  lines.push("## サマリー");
  lines.push("");
  lines.push("| チェック | 判定 | 結果 |");
  lines.push("|----------|------|------|");
  for (const r of results) {
    lines.push(`| ${r.check} | ${SEVERITY_ICON[r.severity]} ${r.severity} | ${r.summary} |`);
  }
  lines.push("");

  // Details for non-pass checks
  for (const r of results) {
    if (r.severity === "pass") continue;
    lines.push(`## ${r.check}`);
    lines.push("");
    lines.push(r.summary);
    lines.push("");
    if (r.items.length > 0) {
      lines.push("| ID | 日付 | 金額 | 説明 | レベル | 理由 |");
      lines.push("|----|------|------|------|--------|------|");
      for (const item of r.items) {
        const id = item.ids ? item.ids.join(",") : String(item.id);
        lines.push(
          `| ${id} | ${item.date ?? ""} | ${item.amount?.toLocaleString() ?? ""} | ${item.description ?? ""} | ${item.level ?? ""} | ${item.reason ?? ""} |`,
        );
      }
      lines.push("");
    }
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    overallSeverity: worst,
    results,
    markdown: lines.join("\n"),
  };
}
