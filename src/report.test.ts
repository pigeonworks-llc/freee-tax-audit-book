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

describe("generateReport: freee links", () => {
  const results: AuditResult[] = [
    {
      check: "receipt_coverage",
      severity: "warning",
      summary: "1 件",
      items: [{ id: 42, date: "2026-03-15", amount: 3500, level: "warning", reason: "未紐付け" }],
    },
  ];

  it("links straight to the statement line when a mapping exists", () => {
    const report = generateReport(results, "FY2026", new Map([[42, 9001]]));
    expect(report.markdown).toContain("[42](https://secure.freee.co.jp/wallet_txns/stream/9001)");
  });

  it("falls back to a filtered deals list without a mapping", () => {
    const report = generateReport(results, "FY2026");
    expect(report.markdown).toContain("issue_date=between_2026-03-15_2026-03-15");
  });
});
