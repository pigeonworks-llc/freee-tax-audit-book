import type { Deal } from "../lib/freee/types.js";
import { describe, expect, it } from "vitest";
import { checkReceiptConsistency, parseVisionResponse, type ReceiptOCR } from "./vision.js";

describe("parseVisionResponse", () => {
  it("parses valid JSON from Vision response", () => {
    const text = '{"amount": 3500, "date": "2026-03-15", "vendor": "Amazon"}';
    const result = parseVisionResponse(text);
    expect(result).toEqual({ amount: 3500, date: "2026-03-15", vendor: "Amazon", registration_number: null });
  });

  it("extracts JSON from markdown code block", () => {
    const text = '```json\n{"amount": 3500, "date": "2026-03-15", "vendor": "Amazon"}\n```';
    const result = parseVisionResponse(text);
    expect(result?.amount).toBe(3500);
  });

  it("returns null for invalid response", () => {
    expect(parseVisionResponse("no json here")).toBeNull();
  });

  it("returns null when the JSON is not a receipt shape", () => {
    expect(parseVisionResponse("[1,2,3]")).toBeNull();
    expect(parseVisionResponse('{"error": "読めません"}')).toEqual({ amount: null, date: null, vendor: null, registration_number: null });
  });

  it("drops non-numeric amounts and malformed dates instead of trusting them", () => {
    expect(parseVisionResponse('{"amount": "三千五百", "date": "3/15", "vendor": ""}')).toEqual({
      amount: null,
      date: null,
      vendor: null,
      registration_number: null,
    });
  });
});

describe("checkReceiptConsistency", () => {
  function makeDeal(overrides: Partial<Deal> = {}): Deal {
    return {
      id: 1,
      company_id: 1,
      issue_date: "2026-03-15",
      type: "expense",
      amount: 3500,
      details: [{ id: 1, account_item_id: 100, account_item_name: "新聞図書費", tax_code: 21, amount: 3500, vat: 350 }],
      receipts: [{ id: 10 }],
      ...overrides,
    };
  }
  const ok: ReceiptOCR = { amount: 3500, date: "2026-03-15", vendor: "Amazon", registration_number: null };

  it("returns pass when amount and date match", () => {
    const result = checkReceiptConsistency([{ deal: makeDeal(), ocrs: [ok], skipped: 0 }]);
    expect(result.severity).toBe("pass");
    expect(result.summary).toContain("検証 1 件");
  });

  it("flags amount mismatch", () => {
    const result = checkReceiptConsistency([{ deal: makeDeal(), ocrs: [{ ...ok, amount: 9999 }], skipped: 0 }]);
    expect(result.severity).toBe("error");
    expect(result.items[0].reason).toContain("金額不一致");
  });

  it("flags date mismatch", () => {
    const result = checkReceiptConsistency([{ deal: makeDeal(), ocrs: [{ ...ok, date: "2026-04-01" }], skipped: 0 }]);
    expect(result.severity).toBe("warning");
    expect(result.items[0].reason).toContain("日付不一致");
  });

  it("passes when one of several receipts matches the deal", () => {
    const result = checkReceiptConsistency([{ deal: makeDeal(), ocrs: [{ ...ok, amount: 1200 }, ok], skipped: 0 }]);
    expect(result.severity).toBe("pass");
  });

  it("reports unreadable receipts as warning instead of skipping them", () => {
    const result = checkReceiptConsistency([{ deal: makeDeal(), ocrs: [null], skipped: 0 }]);
    expect(result.severity).toBe("warning");
    expect(result.items[0].reason).toContain("読取に失敗");
    expect(result.summary).toContain("読取失敗 1 件");
  });

  it("does not claim 問題なし when receipts were left unverified by the per-run cap", () => {
    const result = checkReceiptConsistency([
      { deal: makeDeal({ id: 1 }), ocrs: [ok], skipped: 0 },
      { deal: makeDeal({ id: 2 }), ocrs: [], skipped: 1 },
    ]);
    expect(result.severity).toBe("warning");
    expect(result.summary).toContain("未検証 1 件");
    expect(result.summary).not.toContain("問題なし");
  });
});
