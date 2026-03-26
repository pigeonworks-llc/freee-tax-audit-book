import { describe, expect, it } from "vitest";
import {
  type MonthlyResult,
  generateAnnualReport,
  parseMonthlyResult,
} from "./annual-report.js";

function makeMonthlyResult(
  period: string,
  checks: Array<{ check: string; severity: "pass" | "warning" | "error"; itemCount: number }>,
): MonthlyResult {
  const overallSeverity = checks.some((c) => c.severity === "error")
    ? "error"
    : checks.some((c) => c.severity === "warning")
      ? "warning"
      : "pass";
  return {
    period,
    generatedAt: new Date().toISOString(),
    overallSeverity,
    checks,
  };
}

describe("parseMonthlyResult", () => {
  it("parses JSON string to MonthlyResult", () => {
    const json = JSON.stringify({
      period: "2025-07",
      generatedAt: "2025-08-01T00:00:00Z",
      overallSeverity: "pass",
      checks: [{ check: "receipt_coverage", severity: "pass", itemCount: 0 }],
    });
    const result = parseMonthlyResult(json);
    expect(result.period).toBe("2025-07");
    expect(result.checks).toHaveLength(1);
  });
});

describe("generateAnnualReport", () => {
  it("generates annual report from monthly results", () => {
    const months = [
      makeMonthlyResult("2025-07", [
        { check: "receipt_coverage", severity: "pass", itemCount: 0 },
        { check: "stale_transactions", severity: "warning", itemCount: 2 },
      ]),
      makeMonthlyResult("2025-08", [
        { check: "receipt_coverage", severity: "error", itemCount: 3 },
        { check: "stale_transactions", severity: "pass", itemCount: 0 },
      ]),
    ];
    const report = generateAnnualReport("FY2025", months);
    expect(report.fiscalYear).toBe("FY2025");
    expect(report.overallSeverity).toBe("error");
    expect(report.months).toHaveLength(2);
    expect(report.markdown).toContain("FY2025");
    expect(report.markdown).toContain("receipt_coverage");
  });

  it("returns pass when all months pass", () => {
    const months = [
      makeMonthlyResult("2025-07", [
        { check: "receipt_coverage", severity: "pass", itemCount: 0 },
      ]),
    ];
    const report = generateAnnualReport("FY2025", months);
    expect(report.overallSeverity).toBe("pass");
  });

  it("generates markdown with monthly table", () => {
    const months = [
      makeMonthlyResult("2025-07", [
        { check: "receipt_coverage", severity: "pass", itemCount: 0 },
        { check: "duplicate_deals", severity: "error", itemCount: 1 },
      ]),
      makeMonthlyResult("2025-08", [
        { check: "receipt_coverage", severity: "pass", itemCount: 0 },
        { check: "duplicate_deals", severity: "pass", itemCount: 0 },
      ]),
    ];
    const report = generateAnnualReport("FY2025", months);
    // Should contain severity icons in markdown
    expect(report.markdown).toContain("✓");
    expect(report.markdown).toContain("✗");
  });

  it("handles empty months array", () => {
    const report = generateAnnualReport("FY2025", []);
    expect(report.overallSeverity).toBe("pass");
    expect(report.months).toHaveLength(0);
  });
});
