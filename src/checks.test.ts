import type { Deal, WalletTransaction } from "../lib/freee/types.js";
import { describe, expect, it } from "vitest";
import {
  checkDuplicateDeals,
  checkReceiptCoverage,
  checkStaleTransactions,
  checkTaxCategory,
  isReceiptExempt,
  type ReceiptExemptionRules,
} from "./checks.js";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 1,
    company_id: 1,
    issue_date: "2026-03-15",
    type: "expense",
    amount: 3500,
    details: [
      {
        id: 1,
        account_item_id: 100,
        account_item_name: "新聞図書費",
        tax_code: 21,
        amount: 3500,
        vat: 350,
      },
    ],
    ...overrides,
  };
}

function makeTxn(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: 1,
    company_id: 1,
    date: "2026-03-15",
    amount: 3500,
    due_amount: 3500,
    balance: 0,
    entry_side: "expense",
    walletable_type: "credit_card",
    walletable_id: 1,
    description: "Amazon",
    status: 1,
    ...overrides,
  };
}

describe("E1: checkReceiptCoverage", () => {
  it("flags deals without receipts", () => {
    const deals = [
      makeDeal({ id: 1, receipts: [{ id: 10 }] }),
      makeDeal({ id: 2, receipts: undefined }),
      makeDeal({ id: 3, receipts: [] }),
    ];
    const result = checkReceiptCoverage(deals);
    expect(result.severity).toBe("error");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe(2);
    expect(result.items[1].id).toBe(3);
  });

  it("returns pass when all deals have receipts", () => {
    const deals = [makeDeal({ id: 1, receipts: [{ id: 10 }] })];
    const result = checkReceiptCoverage(deals);
    expect(result.severity).toBe("pass");
    expect(result.items).toHaveLength(0);
  });
  it("exempts zero-amount deals with rules", () => {
    const rules: ReceiptExemptionRules = { zeroAmountThreshold: 1 };
    const deals = [
      makeDeal({ id: 1, amount: 0, receipts: undefined }),
      makeDeal({ id: 2, amount: 1, receipts: undefined }),
      makeDeal({ id: 3, amount: 500, receipts: undefined }),
    ];
    const result = checkReceiptCoverage(deals, rules);
    expect(result.severity).toBe("error");
    const infos = result.items.filter((i) => i.level === "info");
    const errors = result.items.filter((i) => i.level === "error");
    expect(infos).toHaveLength(2); // ¥0 and ¥1
    expect(errors).toHaveLength(1); // ¥500
  });

  it("exempts small amount deals (少額特例)", () => {
    const rules: ReceiptExemptionRules = { smallAmountThreshold: 10000 };
    const deals = [
      makeDeal({ id: 1, amount: 9999, receipts: undefined }),
      makeDeal({ id: 2, amount: 10000, receipts: undefined }),
    ];
    const result = checkReceiptCoverage(deals, rules);
    const infos = result.items.filter((i) => i.level === "info");
    const errors = result.items.filter((i) => i.level === "error");
    expect(infos).toHaveLength(1); // ¥9,999 exempt
    expect(errors).toHaveLength(1); // ¥10,000 not exempt
  });

  it("exempts by account item name", () => {
    const rules: ReceiptExemptionRules = { exemptAccountItems: ["旅費交通費", "支払手数料"] };
    const deals = [
      makeDeal({
        id: 1,
        receipts: undefined,
        details: [{ id: 1, account_item_id: 1, account_item_name: "旅費交通費", tax_code: 21, amount: 5000, vat: 500 }],
      }),
      makeDeal({
        id: 2,
        receipts: undefined,
        details: [{ id: 2, account_item_id: 2, account_item_name: "消耗品費", tax_code: 21, amount: 5000, vat: 500 }],
      }),
    ];
    const result = checkReceiptCoverage(deals, rules);
    const infos = result.items.filter((i) => i.level === "info");
    const errors = result.items.filter((i) => i.level === "error");
    expect(infos).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("returns pass when all missing are exempt", () => {
    const rules: ReceiptExemptionRules = { smallAmountThreshold: 10000 };
    const deals = [
      makeDeal({ id: 1, amount: 5000, receipts: undefined }),
      makeDeal({ id: 2, amount: 15000, receipts: [{ id: 10 }] }),
    ];
    const result = checkReceiptCoverage(deals, rules);
    expect(result.severity).toBe("pass");
  });

  it("isReceiptExempt returns null for non-exempt deal", () => {
    const rules: ReceiptExemptionRules = { smallAmountThreshold: 10000 };
    const deal = makeDeal({ amount: 50000 });
    expect(isReceiptExempt(deal, rules)).toBeNull();
  });
});

describe("E4: checkStaleTransactions", () => {
  it("flags transactions older than 30 days as warning", () => {
    const now = new Date("2026-03-22");
    const txns = [
      makeTxn({ id: 1, date: "2026-03-20" }), // 2 days - ok
      makeTxn({ id: 2, date: "2026-02-15" }), // 35 days - warning
      makeTxn({ id: 3, date: "2025-12-01" }), // 111 days - error
    ];
    const result = checkStaleTransactions(txns, now);
    expect(result.items).toHaveLength(2);
    const warn = result.items.find((i) => i.id === 2);
    expect(warn?.level).toBe("warning");
    const err = result.items.find((i) => i.id === 3);
    expect(err?.level).toBe("error");
  });

  it("returns pass when no stale transactions", () => {
    const now = new Date("2026-03-22");
    const txns = [makeTxn({ date: "2026-03-20" })];
    const result = checkStaleTransactions(txns, now);
    expect(result.severity).toBe("pass");
  });
});

describe("E5: checkDuplicateDeals", () => {
  it("detects duplicate deals by amount+date+description", () => {
    const deals = [
      makeDeal({
        id: 1,
        issue_date: "2026-03-15",
        amount: 3500,
        details: [
          {
            id: 1,
            account_item_id: 100,
            account_item_name: "新聞図書費",
            tax_code: 21,
            amount: 3500,
            vat: 350,
            description: "Amazon",
          },
        ],
      }),
      makeDeal({
        id: 2,
        issue_date: "2026-03-15",
        amount: 3500,
        details: [
          {
            id: 2,
            account_item_id: 100,
            account_item_name: "新聞図書費",
            tax_code: 21,
            amount: 3500,
            vat: 350,
            description: "Amazon",
          },
        ],
      }),
      makeDeal({
        id: 3,
        issue_date: "2026-03-16",
        amount: 5000,
        details: [{ id: 3, account_item_id: 200, account_item_name: "通信費", tax_code: 21, amount: 5000, vat: 500 }],
      }),
    ];
    const result = checkDuplicateDeals(deals);
    expect(result.severity).toBe("error");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].ids).toContain(1);
    expect(result.items[0].ids).toContain(2);
  });

  it("returns pass when no duplicates", () => {
    const deals = [makeDeal({ id: 1, amount: 3500 }), makeDeal({ id: 2, amount: 5000, issue_date: "2026-03-16" })];
    const result = checkDuplicateDeals(deals);
    expect(result.severity).toBe("pass");
  });
});

describe("E3: checkTaxCategory", () => {
  const foreignVendors = ["aws", "github", "openai", "anthropic"];

  it("flags foreign vendors with domestic tax code", () => {
    const deals = [
      makeDeal({
        id: 1,
        details: [
          {
            id: 1,
            account_item_id: 100,
            account_item_name: "通信費",
            tax_code: 21,
            amount: 5000,
            vat: 500,
            description: "AWS",
          },
        ],
      }),
    ];
    const result = checkTaxCategory(deals, foreignVendors);
    expect(result.severity).toBe("warning");
    expect(result.items).toHaveLength(1);
  });

  it("passes for foreign vendors with non-taxable code", () => {
    const deals = [
      makeDeal({
        id: 1,
        details: [
          {
            id: 1,
            account_item_id: 100,
            account_item_name: "通信費",
            tax_code: 0,
            amount: 5000,
            vat: 0,
            description: "AWS",
          },
        ],
      }),
    ];
    const result = checkTaxCategory(deals, foreignVendors);
    expect(result.severity).toBe("pass");
  });
});
