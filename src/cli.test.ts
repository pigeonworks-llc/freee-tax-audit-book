import { describe, expect, it } from "vitest";
import { parseAuditArgs, resolveFiscalStartMonth } from "./cli.js";

describe("parseAuditArgs", () => {
  const jan15 = new Date(2026, 0, 15); // 2026-01-15
  const aug10 = new Date(2025, 7, 10); // 2025-08-10

  it("defaults to current month range", () => {
    const args = parseAuditArgs([], jan15);
    expect(args.startDate).toBe("2026-01-01");
    expect(args.endDate).toBe("2026-01-15");
    expect(args.isMonthly).toBe(false);
  });

  it("--monthly uses fiscal year start (Jul 1)", () => {
    const args = parseAuditArgs(["--monthly"], jan15);
    expect(args.startDate).toBe("2025-07-01");
    expect(args.period).toBe("FY2025");
    expect(args.isMonthly).toBe(true);
  });

  it("--monthly in H1 uses previous fiscal year", () => {
    const args = parseAuditArgs(["--monthly"], aug10);
    expect(args.startDate).toBe("2025-07-01");
    expect(args.period).toBe("FY2025");
  });

  it("--full-check flag", () => {
    const args = parseAuditArgs(["--full-check"], jan15);
    expect(args.fullCheck).toBe(true);
  });

  it("--sheets flag", () => {
    const args = parseAuditArgs(["--sheets"], jan15);
    expect(args.exportSheets).toBe(true);
  });

  it("first non-flag arg is output path", () => {
    const args = parseAuditArgs(["output.md", "--monthly"], jan15);
    expect(args.outPath).toBe("output.md");
  });
});

describe("fiscal year start month", () => {
  it("defaults to July when FISCAL_START_MONTH is unset", () => {
    expect(resolveFiscalStartMonth(undefined)).toBe(7);
    expect(resolveFiscalStartMonth("")).toBe(7);
  });

  it("accepts a month between 1 and 12", () => {
    expect(resolveFiscalStartMonth("1")).toBe(1);
    expect(resolveFiscalStartMonth("12")).toBe(12);
  });

  it("falls back to the default for an out-of-range or non-numeric value", () => {
    expect(resolveFiscalStartMonth("0")).toBe(7);
    expect(resolveFiscalStartMonth("13")).toBe(7);
    expect(resolveFiscalStartMonth("春")).toBe(7);
  });

  it("uses January 1 as the fiscal year start for a calendar-year company", () => {
    const args = parseAuditArgs(["--monthly"], new Date(2026, 7, 15), 1);
    expect(args.startDate).toBe("2026-01-01");
    expect(args.period).toBe("FY2026");
  });

  it("rolls back to the previous year before the fiscal start month", () => {
    const args = parseAuditArgs(["--monthly"], new Date(2026, 2, 15), 4);
    expect(args.startDate).toBe("2025-04-01");
    expect(args.period).toBe("FY2025");
  });

  it("starts the new fiscal year in the fiscal start month itself", () => {
    const args = parseAuditArgs(["--monthly"], new Date(2026, 3, 1), 4);
    expect(args.startDate).toBe("2026-04-01");
  });
});
