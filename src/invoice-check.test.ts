import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceCache } from "./invoice-cache.js";
import {
  checkInvoiceRegistration,
  extractRegistrationNumber,
  queryNtaApi,
  type InvoiceEntry,
} from "./invoice-check.js";

describe("extractRegistrationNumber", () => {
  it("extracts T + 13 digits", () => {
    expect(extractRegistrationNumber("登録番号: T1234567890123")).toBe("T1234567890123");
  });

  it("extracts from multiline text", () => {
    const text = "株式会社テスト\n登録番号 T9876543210001\n東京都";
    expect(extractRegistrationNumber(text)).toBe("T9876543210001");
  });

  it("returns null when no registration number", () => {
    expect(extractRegistrationNumber("Amazon.co.jp ¥3,500")).toBeNull();
  });

  it("ignores T with wrong digit count", () => {
    expect(extractRegistrationNumber("T12345")).toBeNull();
    expect(extractRegistrationNumber("T12345678901234")).toBeNull();
  });

  it("handles full-width T", () => {
    expect(extractRegistrationNumber("Ｔ1234567890123")).toBe("T1234567890123");
  });
});

describe("queryNtaApi", () => {
  function mockFetch(body: object, status = 200): typeof fetch {
    return (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
  }

  it("returns valid=true for active registration", async () => {
    const result = await queryNtaApi(
      "T1234567890123",
      mockFetch({
        announcement: {
          count: "1",
          announcement: [
            {
              registratedNumber: "T1234567890123",
              process: "01",
              name: "株式会社テスト",
              registrationDate: "2023-10-01",
            },
          ],
        },
      }),
    );
    expect(result).toEqual({ valid: true, name: "株式会社テスト" });
  });

  it("returns valid=false for revoked registration (process=99)", async () => {
    const result = await queryNtaApi(
      "T1234567890123",
      mockFetch({
        announcement: {
          count: "1",
          announcement: [
            {
              registratedNumber: "T1234567890123",
              process: "99",
              name: "株式会社テスト",
              registrationDate: "2023-10-01",
            },
          ],
        },
      }),
    );
    expect(result).toEqual({ valid: false, name: "株式会社テスト" });
  });

  it("returns valid=false for unknown number (count=0)", async () => {
    const result = await queryNtaApi(
      "T0000000000000",
      mockFetch({ announcement: { count: "0", announcement: [] } }),
    );
    expect(result).toEqual({ valid: false, name: null });
  });

  it("returns null on API error", async () => {
    const result = await queryNtaApi("T1234567890123", mockFetch({}, 500));
    expect(result).toBeNull();
  });
});

describe("checkInvoiceRegistration", () => {
  let cache: InvoiceCache;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "invoice-check-"));
    cache = new InvoiceCache(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pass when all registrations are valid", async () => {
    cache.set("T1234567890123", true, "株式会社テスト");
    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: "T1234567890123", issueDate: "2026-03-15", amount: 3500 },
    ];
    const result = await checkInvoiceRegistration(entries, cache);
    expect(result.severity).toBe("pass");
  });

  it("flags invalid registration as error", async () => {
    cache.set("T9999999999999", false);
    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: "T9999999999999", issueDate: "2026-03-15", amount: 3500 },
    ];
    const result = await checkInvoiceRegistration(entries, cache);
    expect(result.severity).toBe("error");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].level).toBe("error");
  });

  it("reports missing registration number as info", async () => {
    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: null, issueDate: "2026-03-15", amount: 3500 },
    ];
    const result = await checkInvoiceRegistration(entries, cache);
    expect(result.severity).toBe("pass");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].level).toBe("info");
  });

  it("calls NTA API for uncached entries", async () => {
    const mockHttp = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        announcement: {
          count: "1",
          announcement: [
            { registratedNumber: "T1111111111111", process: "01", name: "新規事業者" },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: "T1111111111111", issueDate: "2026-03-15", amount: 5000 },
    ];
    const result = await checkInvoiceRegistration(entries, cache, mockHttp);
    expect(result.severity).toBe("pass");
    // Should be cached now
    expect(cache.get("T1111111111111")).toEqual({ valid: true, name: "新規事業者" });
  });

  it("deduplicates same registration number across deals", async () => {
    let apiCalls = 0;
    const mockHttp = (async () => {
      apiCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          announcement: {
            count: "1",
            announcement: [
              { registratedNumber: "T1111111111111", process: "01", name: "事業者" },
            ],
          },
        }),
      };
    }) as unknown as typeof fetch;

    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: "T1111111111111", issueDate: "2026-03-15", amount: 3000 },
      { dealId: 2, regNumber: "T1111111111111", issueDate: "2026-03-16", amount: 5000 },
    ];
    await checkInvoiceRegistration(entries, cache, mockHttp);
    expect(apiCalls).toBe(1);
  });
});
