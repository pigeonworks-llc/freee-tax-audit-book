import { describe, expect, it } from "vitest";
import { fiscalYearOf, parseAuditArgs, resolveFiscalStartMonth } from "./cli.js";

describe("parseAuditArgs", () => {
  const jan15 = new Date(2026, 0, 15); // 2026-01-15
  const aug10 = new Date(2025, 7, 10); // 2025-08-10
  const jul1 = new Date(2026, 6, 1); // 2026-07-01 (期首当日)

  it("defaults to current month range", () => {
    const args = parseAuditArgs([], jan15);
    expect(args.startDate).toBe("2026-01-01");
    expect(args.endDate).toBe("2026-01-15");
    expect(args.mode).toBe("current-month");
    expect(args.period).toBe("2026-01");
  });

  it("--previous targets the whole previous month, across a year boundary", () => {
    const args = parseAuditArgs(["--previous"], jan15);
    expect(args.startDate).toBe("2025-12-01");
    expect(args.endDate).toBe("2025-12-31");
    expect(args.period).toBe("2025-12");
    expect(args.mode).toBe("previous-month");
  });

  it("--previous on the first day of a fiscal year still closes the previous period's last month", () => {
    const args = parseAuditArgs(["--previous"], jul1);
    expect(args.startDate).toBe("2026-06-01");
    expect(args.endDate).toBe("2026-06-30");
  });

  it("--monthly is fiscal year-to-date and its period label carries the end date so runs do not collide", () => {
    const args = parseAuditArgs(["--monthly"], jan15);
    expect(args.startDate).toBe("2025-07-01");
    expect(args.endDate).toBe("2026-01-15");
    expect(args.mode).toBe("fiscal-ytd");
    expect(args.isMonthly).toBe(true);
    expect(args.period).toBe("FY2025-ytd-2026-01-15");
    expect(parseAuditArgs(["--monthly"], new Date(2026, 1, 1)).period).not.toBe(args.period);
  });

  it("--monthly in H1 uses previous fiscal year", () => {
    const args = parseAuditArgs(["--monthly"], aug10);
    expect(args.startDate).toBe("2025-07-01");
    expect(args.period.startsWith("FY2025")).toBe(true);
  });

  it("--from/--to select an explicit range", () => {
    const args = parseAuditArgs(["--from", "2025-10-01", "--to", "2025-12-31", "out.md"], jan15);
    expect(args.startDate).toBe("2025-10-01");
    expect(args.endDate).toBe("2025-12-31");
    expect(args.outPath).toBe("out.md");
  });

  it("--full-check / --sheets / --vision flags", () => {
    const args = parseAuditArgs(["--full-check", "--sheets", "--vision"], jan15);
    expect(args.fullCheck).toBe(true);
    expect(args.exportSheets).toBe(true);
    expect(args.enableVision).toBe(true);
  });

  it("first non-flag arg is output path", () => {
    const args = parseAuditArgs(["output.md", "--monthly"], jan15);
    expect(args.outPath).toBe("output.md");
  });

  it("--annual defaults to the previous fiscal year and accepts --fiscal-year", () => {
    const d = parseAuditArgs(["--annual"], aug10);
    expect(d.fiscalYearLabel).toBe("FY2024");
    expect(d.fiscalYearStart).toBe("2024-07-01");
    expect(d.fiscalYearEnd).toBe("2025-06-30");
    const e = parseAuditArgs(["--annual", "--fiscal-year", "FY2025"], aug10);
    expect(e.fiscalYearLabel).toBe("FY2025");
    expect(e.fiscalYearEnd).toBe("2026-06-30");
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
    expect(args.period.startsWith("FY2026")).toBe(true);
    expect(parseAuditArgs(["--annual", "--fiscal-year", "2025"], new Date(2026, 7, 15), 1).fiscalYearEnd).toBe("2025-12-31");
  });

  it("rolls back to the previous year before the fiscal start month", () => {
    const args = parseAuditArgs(["--monthly"], new Date(2026, 2, 15), 4);
    expect(args.startDate).toBe("2025-04-01");
    expect(fiscalYearOf(new Date(2026, 2, 15), 4)).toBe(2025);
  });

  it("starts the new fiscal year in the fiscal start month itself", () => {
    const args = parseAuditArgs(["--monthly"], new Date(2026, 3, 1), 4);
    expect(args.startDate).toBe("2026-04-01");
  });
});
