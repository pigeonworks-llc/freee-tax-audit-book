import { describe, expect, it } from "vitest";
import { OcrCache } from "./ocr-cache.js";

describe("OcrCache", () => {
  it("returns null for an unread receipt", () => {
    const cache = new OcrCache(":memory:");
    expect(cache.get(1)).toBeNull();
    cache.close();
  });

  it("stores and retrieves an OCR result", () => {
    const cache = new OcrCache(":memory:");
    const ocr = { amount: 3500, date: "2026-03-15", vendor: "Amazon", registration_number: null };
    cache.set(10, ocr);
    expect(cache.get(10)).toEqual({ ocr, failed: false });
    cache.close();
  });
});
