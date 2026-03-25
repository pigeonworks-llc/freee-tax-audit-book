import { describe, expect, it } from "vitest";
import { parseAuditArgs } from "./cli.js";

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
