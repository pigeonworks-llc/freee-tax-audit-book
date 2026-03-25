import { describe, expect, it } from "vitest";
import type { AuditResult } from "./checks.js";
import { buildSheetData } from "./sheets.js";

describe("buildSheetData", () => {
  it("skips pass results, only creates detail sheets", () => {
    const results: AuditResult[] = [{ check: "stale", severity: "pass", summary: "ok", items: [] }];
    const sheets = buildSheetData(results, "FY2025");
    expect(sheets.details).toHaveLength(0);
  });

  it("includes wallet_txn direct link when mapping provided", () => {
    const results: AuditResult[] = [
      {
        check: "receipt_coverage",
        severity: "error",
        summary: "2 件未添付",
        items: [
          { id: 1, date: "2026-03-15", amount: 3500, level: "error", reason: "未添付" },
          { id: 2, date: "2026-03-16", amount: 5000, level: "error", reason: "未添付" },
        ],
      },
    ];

    const mapping = new Map([
      [1, 9999001],
      [2, 9999002],
    ]);
    const sheets = buildSheetData(results, "FY2025", mapping);
    expect(sheets.details).toHaveLength(1);
    expect(sheets.details[0].rows).toHaveLength(3);
    expect(sheets.details[0].rows[0][1]).toBe("freee URL");
    expect(sheets.details[0].rows[1][1]).toBe("https://secure.freee.co.jp/wallet_txns/stream/9999001");
    expect(sheets.details[0].rows[2][1]).toBe("https://secure.freee.co.jp/wallet_txns/stream/9999002");
  });

  it("generates multiple URLs for duplicate deal groups", () => {
    const results: AuditResult[] = [
      {
        check: "duplicate_deals",
        severity: "error",
        summary: "1 グループ",
        items: [{ id: 10, ids: [10, 20], date: "2026-03-11", amount: 792, level: "error", reason: "2 件の重複" }],
      },
    ];

    const mapping = new Map([
      [10, 8888001],
      [20, 8888002],
    ]);
    const sheets = buildSheetData(results, "FY2025", mapping);
    const url = sheets.details[0].rows[1][1] as string;
    expect(url).toContain("8888001");
    expect(url).toContain("8888002");
  });

  it("leaves URL empty when no mapping exists", () => {
    const results: AuditResult[] = [
      {
        check: "receipt_coverage",
        severity: "error",
        summary: "1 件",
        items: [{ id: 99, date: "2026-03-15", amount: 100, level: "error", reason: "未添付" }],
      },
    ];

    const sheets = buildSheetData(results, "FY2025", new Map());
    expect(sheets.details[0].rows[1][1]).toBe("");
  });
});
