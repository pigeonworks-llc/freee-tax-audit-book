import { describe, expect, it } from "vitest";
import { checkDuplicateDeals, checkReceiptCoverage, checkStaleTransactions, checkTaxCategory } from "./checks.js";
import { generateReport } from "./report.js";

describe("tax-audit module exports", () => {
  it("exports all check functions", () => {
    expect(checkReceiptCoverage).toBeTypeOf("function");
    expect(checkStaleTransactions).toBeTypeOf("function");
    expect(checkDuplicateDeals).toBeTypeOf("function");
    expect(checkTaxCategory).toBeTypeOf("function");
  });

  it("exports report generator", () => {
    expect(generateReport).toBeTypeOf("function");
  });
});
