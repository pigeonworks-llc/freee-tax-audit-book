import { describe, expect, it } from "vitest";
import type { AuditResult } from "./checks.js";
import { generateReport } from "./report.js";

describe("generateReport", () => {
  it("generates markdown report from audit results", () => {
    const results: AuditResult[] = [
      {
        check: "receipt_coverage",
        severity: "error",
        summary: "2/10 件の取引にレシート未添付",
        items: [
          { id: 1, date: "2026-03-15", amount: 3500, level: "error", reason: "レシート未添付" },
          { id: 2, date: "2026-03-16", amount: 5000, level: "error", reason: "レシート未添付" },
        ],
      },
      {
        check: "stale_transactions",
        severity: "pass",
        summary: "放置された未登録取引なし",
        items: [],
      },
    ];

    const report = generateReport(results, "2026-03");
    expect(report.markdown).toContain("# 税務監査レポート");
    expect(report.markdown).toContain("2026-03");
    expect(report.markdown).toContain("レシート未添付");
    expect(report.markdown).toContain("pass");
    expect(report.overallSeverity).toBe("error");
  });

  it("overall severity is pass when all checks pass", () => {
    const results: AuditResult[] = [
      { check: "a", severity: "pass", summary: "ok", items: [] },
      { check: "b", severity: "pass", summary: "ok", items: [] },
    ];
    const report = generateReport(results, "2026-03");
    expect(report.overallSeverity).toBe("pass");
  });

  it("overall severity is warning when worst is warning", () => {
    const results: AuditResult[] = [
      { check: "a", severity: "pass", summary: "ok", items: [] },
      { check: "b", severity: "warning", summary: "warn", items: [] },
    ];
    const report = generateReport(results, "2026-03");
    expect(report.overallSeverity).toBe("warning");
  });
});
