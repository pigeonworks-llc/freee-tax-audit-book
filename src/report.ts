import type { AuditResult } from "./checks.js";
import { dealsFilterUrl, walletTxnUrl } from "./freee-links.js";

export interface AuditReport {
  period: string;
  generatedAt: string;
  overallSeverity: "pass" | "warning" | "error";
  results: AuditResult[];
  markdown: string;
}

const SEVERITY_ORDER = { pass: 0, warning: 1, error: 2 } as const;
const SEVERITY_ICON = { pass: "✓", warning: "!", error: "✗" } as const;

/**
 * @param dealToWalletTxnId deal_id → wallet_txn_id. Lets each row link straight
 *   to the statement line; deals without a mapped statement fall back to a
 *   filtered deals list. Without a link, confirming a few hundred findings
 *   means searching freee for one ID at a time.
 */
export function generateReport(
  results: AuditResult[],
  period: string,
  dealToWalletTxnId?: Map<number, number>,
): AuditReport {
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
      lines.push("| ID | freee | 日付 | 金額 | 説明 | レベル | 理由 |");
      lines.push("|----|-------|------|------|------|--------|------|");
      for (const item of r.items) {
        const ids = item.ids ?? [item.id];
        const links = ids
          .map((id) => {
            const wtId = dealToWalletTxnId?.get(id);
            const url = wtId ? walletTxnUrl(wtId) : dealsFilterUrl(item.date, item.amount);
            return url ? `[${id}](${url})` : "";
          })
          .filter(Boolean)
          .join(" ");
        lines.push(
          `| ${ids.join(",")} | ${links} | ${item.date ?? ""} | ${item.amount?.toLocaleString() ?? ""} | ${item.description ?? ""} | ${item.level ?? ""} | ${item.reason ?? ""} |`,
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
