import { describe, expect, it } from "vitest";
import { generateAnnualReport, type MonthlyResult, monthsBetween, parseMonthlyResult, toMonthlyResult } from "./annual-report.js";

function month(
  period: string,
  checks: Array<{ check: string; severity: "pass" | "warning" | "error"; itemCount: number }>,
  generatedAt = "2026-01-01T00:00:00.000Z",
): MonthlyResult {
  const overallSeverity = checks.some((c) => c.severity === "error")
    ? "error"
    : checks.some((c) => c.severity === "warning")
      ? "warning"
      : "pass";
  const [y, m] = period.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { period, generatedAt, startDate: `${period}-01`, endDate: `${period}-${last}`, overallSeverity, checks };
}
const FY = { fiscalYearStart: "2025-07-01", fiscalYearEnd: "2026-06-30" };
const pass = [{ check: "receipt_coverage", severity: "pass" as const, itemCount: 0 }];

describe("parseMonthlyResult / toMonthlyResult", () => {
  it("round-trips period, range and item details", () => {
    const r = toMonthlyResult(
      "2025-07",
      [{ check: "receipt_coverage", severity: "warning", summary: "1 件", items: [{ id: 5, reason: "未紐付け" }] }],
      { startDate: "2025-07-01", endDate: "2025-07-31", mode: "previous-month" },
    );
    const back = parseMonthlyResult(JSON.stringify(r));
    expect(back.startDate).toBe("2025-07-01");
    expect(back.checks[0].items?.[0].reason).toBe("未紐付け");
  });
});

describe("monthsBetween", () => {
  it("lists months across a year boundary", () => {
    expect(monthsBetween("2025-11-01", "2026-02-28")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("generateAnnualReport", () => {
  it("aggregates and takes the worst severity", () => {
    const report = generateAnnualReport(
      "FY2025",
      [
        month("2025-07", [{ check: "receipt_coverage", severity: "pass", itemCount: 0 }, { check: "stale_transactions", severity: "warning", itemCount: 2 }]),
        month("2025-08", [{ check: "receipt_coverage", severity: "error", itemCount: 3 }, { check: "stale_transactions", severity: "pass", itemCount: 0 }]),
      ],
    );
    expect(report.overallSeverity).toBe("error");
    expect(report.months).toHaveLength(2);
    expect(report.markdown).toContain("receipt_coverage");
  });

  it("does not report an annual pass when months of the fiscal year are missing", () => {
    const report = generateAnnualReport("FY2025", [month("2025-07", pass)], FY);
    expect(report.overallSeverity).toBe("warning");
    expect(report.coverage.missing).toHaveLength(11);
    expect(report.markdown).toContain("結果が無い月");
    expect(report.markdown).not.toContain("年間を通じてすべてのチェックが問題なく通過しました");
  });

  it("reports an annual pass only when every month is covered", () => {
    const all = monthsBetween(FY.fiscalYearStart, FY.fiscalYearEnd).map((m) => month(m, pass));
    const report = generateAnnualReport("FY2025", all, FY);
    expect(report.overallSeverity).toBe("pass");
    expect(report.coverage.missing).toEqual([]);
    expect(report.markdown).toContain("年間を通じてすべてのチェックが問題なく通過しました");
  });

  it("excludes results outside the fiscal year and keeps the latest run per period", () => {
    const report = generateAnnualReport(
      "FY2025",
      [
        month("2025-06", [{ check: "receipt_coverage", severity: "error", itemCount: 9 }]), // 前期
        month("2025-07", [{ check: "receipt_coverage", severity: "error", itemCount: 1 }], "2025-08-01T00:00:00.000Z"),
        month("2025-07", pass, "2025-08-15T00:00:00.000Z"), // 是正後の再実行
      ],
      FY,
    );
    expect(report.months).toHaveLength(1);
    expect(report.months[0].overallSeverity).toBe("pass");
  });

  it("marks checks that did not run in a period as 未実施", () => {
    const report = generateAnnualReport("FY2025", [
      month("2025-07", [{ check: "receipt_coverage", severity: "pass", itemCount: 0 }, { check: "invoice_registration", severity: "pass", itemCount: 0 }]),
      month("2025-08", [{ check: "receipt_coverage", severity: "pass", itemCount: 0 }]),
    ]);
    expect(report.markdown).toContain("未実施");
    expect(report.markdown).toContain("2025-08: invoice_registration");
  });

  it("handles empty results", () => {
    const report = generateAnnualReport("FY2025", []);
    expect(report.overallSeverity).toBe("pass");
    expect(report.months).toHaveLength(0);
  });
});
