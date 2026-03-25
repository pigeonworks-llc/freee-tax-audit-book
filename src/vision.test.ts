import type { Deal } from "../lib/freee/types.js";
import { describe, expect, it } from "vitest";
import { checkReceiptConsistency, parseVisionResponse, type ReceiptOCR } from "./vision.js";

describe("parseVisionResponse", () => {
  it("parses valid JSON from Vision response", () => {
    const text = '{"amount": 3500, "date": "2026-03-15", "vendor": "Amazon"}';
    const result = parseVisionResponse(text);
    expect(result).toEqual({ amount: 3500, date: "2026-03-15", vendor: "Amazon" });
  });

  it("extracts JSON from markdown code block", () => {
    const text = '```json\n{"amount": 3500, "date": "2026-03-15", "vendor": "Amazon"}\n```';
    const result = parseVisionResponse(text);
    expect(result?.amount).toBe(3500);
  });

  it("returns null for invalid response", () => {
    expect(parseVisionResponse("no json here")).toBeNull();
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
      receipts: [{ id: 10 }],
      ...overrides,
    };
  }

  it("returns pass when amount and date match", () => {
    const ocr: ReceiptOCR = { amount: 3500, date: "2026-03-15", vendor: "Amazon", registration_number: null };
    const deal = makeDeal();
    const result = checkReceiptConsistency([{ deal, ocr }]);
    expect(result.severity).toBe("pass");
  });

  it("flags amount mismatch", () => {
    const ocr: ReceiptOCR = { amount: 9999, date: "2026-03-15", vendor: "Amazon", registration_number: null };
    const deal = makeDeal();
    const result = checkReceiptConsistency([{ deal, ocr }]);
    expect(result.severity).toBe("error");
    expect(result.items[0].reason).toContain("金額不一致");
  });

  it("flags date mismatch", () => {
    const ocr: ReceiptOCR = { amount: 3500, date: "2026-04-01", vendor: "Amazon", registration_number: null };
    const deal = makeDeal();
    const result = checkReceiptConsistency([{ deal, ocr }]);
    expect(result.severity).toBe("warning");
    expect(result.items[0].reason).toContain("日付不一致");
  });

  it("skips deals without OCR data", () => {
    const result = checkReceiptConsistency([{ deal: makeDeal(), ocr: null }]);
    expect(result.severity).toBe("pass");
    expect(result.items).toHaveLength(0);
  });
});
