import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceCache } from "./invoice-cache.js";
import {
  checkInvoiceRegistration,
  extractRegistrationNumber,
  type InvoiceEntry,
  issuerNameMatches,
  queryNtaValidity,
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

/**
 * 国税庁 Web-API 機能仕様書 第二編 §4.3 ケース12（/1/valid, type=21）の応答形状。
 * ヘッダ項目 (lastUpdateDate/count/divideNumber/divideSize) と announcement[] は同階層。
 */
function ntaJson(announcement: Array<Record<string, string>>) {
  return {
    lastUpdateDate: "2021-12-01",
    count: String(announcement.length),
    divideNumber: "1",
    divideSize: "1",
    announcement,
  };
}

function activeEntry(overrides: Record<string, string> = {}) {
  return {
    sequenceNumber: "1",
    registratedNumber: "T8040001999011",
    process: "01",
    correct: "0",
    kind: "2",
    country: "1",
    latest: "1",
    registrationDate: "2023-10-01",
    updateDate: "2021-11-01",
    disposalDate: "",
    expireDate: "",
    name: "株式会社インボイス公表",
    ...overrides,
  };
}

describe("queryNtaValidity", () => {
  let calledUrl = "";
  function mockFetch(body: object, status = 200): typeof fetch {
    return (async (url: string) => {
      calledUrl = String(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as unknown as typeof fetch;
  }
  const opts = (body: object, status = 200) => ({ appId: "SK1234567890123", httpClient: mockFetch(body, status) });

  it("sends the application ID as id, the registration number as number, and the deal date as day", async () => {
    await queryNtaValidity("T8040001999011", "2023-12-01", opts(ntaJson([activeEntry()])));
    const url = new URL(calledUrl);
    expect(url.pathname).toBe("/1/valid");
    expect(url.searchParams.get("id")).toBe("SK1234567890123");
    expect(url.searchParams.get("number")).toBe("T8040001999011");
    expect(url.searchParams.get("day")).toBe("2023-12-01");
    expect(url.searchParams.get("type")).toBe("21");
  });

  it("parses the official flat response shape and returns valid=true for process=01", async () => {
    const result = await queryNtaValidity("T8040001999011", "2023-12-01", opts(ntaJson([activeEntry()])));
    expect(result?.valid).toBe(true);
    expect(result?.name).toBe("株式会社インボイス公表");
    expect(result?.basis).toContain("2023-10-01");
  });

  it("treats process=03 (登録の失効) as invalid", async () => {
    const result = await queryNtaValidity(
      "T8040001999011",
      "2024-12-01",
      opts(ntaJson([activeEntry({ process: "03", expireDate: "2024-11-01" })])),
    );
    expect(result?.valid).toBe(false);
    expect(result?.basis).toContain("失効");
  });

  it("treats process=04 (登録の取消) as invalid", async () => {
    const result = await queryNtaValidity(
      "T8040001999011",
      "2024-12-01",
      opts(ntaJson([activeEntry({ process: "04", disposalDate: "2024-06-30" })])),
    );
    expect(result?.valid).toBe(false);
    expect(result?.basis).toContain("取消");
  });

  it("treats a deal dated before the registration date as invalid", async () => {
    const result = await queryNtaValidity("T8040001999011", "2023-09-15", opts(ntaJson([activeEntry()])));
    expect(result?.valid).toBe(false);
    expect(result?.basis).toContain("登録日");
  });

  it("returns valid=false with a basis for count=0", async () => {
    const result = await queryNtaValidity("T0000000000000", "2023-12-01", opts(ntaJson([])));
    expect(result).toEqual({ valid: false, name: null, basis: "2023-12-01 時点で公表情報なし" });
  });

  it("returns null (確認不能) on HTTP error", async () => {
    expect(await queryNtaValidity("T8040001999011", "2023-12-01", opts({}, 500))).toBeNull();
  });

  it("returns null (確認不能) when the response is not the official shape", async () => {
    // 旧実装が期待していた誤った入れ子構造。実 API はこの形を返さない。
    const wrong = { announcement: { count: "1", announcement: [activeEntry()] } };
    expect(await queryNtaValidity("T8040001999011", "2023-12-01", opts(wrong))).toBeNull();
  });
});

describe("issuerNameMatches", () => {
  it("ignores corporate suffixes, width and spacing", () => {
    expect(issuerNameMatches("ｲﾝﾎﾞｲｽ公表", "株式会社インボイス公表")).toBe(true); // NFKC で半角カナも畳む
    expect(issuerNameMatches("インボイス公表", "株式会社インボイス公表")).toBe(true);
    expect(issuerNameMatches("(株) インボイス 公表", "株式会社インボイス公表")).toBe(true);
  });

  it("does not judge when either side is empty", () => {
    expect(issuerNameMatches(null, "株式会社テスト")).toBe(true);
    expect(issuerNameMatches("テスト", null)).toBe(true);
  });

  it("flags a clearly different issuer", () => {
    expect(issuerNameMatches("Amazon Japan", "株式会社インボイス公表")).toBe(false);
  });
});

describe("checkInvoiceRegistration", () => {
  let cache: InvoiceCache;
  let tmpDir: string;
  const appId = "SK1234567890123";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "invoice-check-"));
    cache = new InvoiceCache(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function httpReturning(body: object, counter?: { calls: number }): typeof fetch {
    return (async () => {
      if (counter) counter.calls++;
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
  }

  it("returns pass when the cached result for the deal date is valid", async () => {
    cache.set("T1234567890123", "2026-03-15", { valid: true, name: "株式会社テスト", basis: "登録済み" });
    const entries: InvoiceEntry[] = [{ dealId: 1, regNumber: "T1234567890123", issueDate: "2026-03-15", amount: 3500 }];
    const result = await checkInvoiceRegistration(entries, cache, { appId });
    expect(result.severity).toBe("pass");
    expect(result.summary).toContain("1 件中 1 件");
  });

  it("flags invalid registration as error with the basis", async () => {
    cache.set("T9999999999999", "2026-03-15", { valid: false, name: null, basis: "登録の失効" });
    const entries: InvoiceEntry[] = [{ dealId: 1, regNumber: "T9999999999999", issueDate: "2026-03-15", amount: 3500 }];
    const result = await checkInvoiceRegistration(entries, cache, { appId });
    expect(result.severity).toBe("error");
    expect(result.items[0].reason).toContain("登録の失効");
  });

  it("reports missing registration number as info", async () => {
    const entries: InvoiceEntry[] = [{ dealId: 1, regNumber: null, issueDate: "2026-03-15", amount: 3500 }];
    const result = await checkInvoiceRegistration(entries, cache, { appId });
    expect(result.severity).toBe("pass");
    expect(result.items[0].level).toBe("info");
  });

  it("reports an OCR failure as warning, never as 登録番号なし", async () => {
    const entries: InvoiceEntry[] = [{ dealId: 1, regNumber: null, issueDate: "2026-03-15", amount: 3500, ocrFailed: true }];
    const result = await checkInvoiceRegistration(entries, cache, { appId });
    expect(result.severity).toBe("warning");
    expect(result.items[0].reason).toContain("読取に失敗");
  });

  it("reports 確認不能 instead of pass when no application ID is configured", async () => {
    const entries: InvoiceEntry[] = [{ dealId: 1, regNumber: "T1234567890123", issueDate: "2026-03-15", amount: 3500 }];
    const result = await checkInvoiceRegistration(entries, cache, {});
    expect(result.severity).toBe("warning");
    expect(result.items[0].reason).toContain("NTA_APP_ID");
  });

  it("calls NTA API for uncached entries and caches by deal date", async () => {
    const entries: InvoiceEntry[] = [{ dealId: 1, regNumber: "T8040001999011", issueDate: "2026-03-15", amount: 5000 }];
    const result = await checkInvoiceRegistration(entries, cache, {
      appId,
      httpClient: httpReturning(ntaJson([activeEntry()])),
    });
    expect(result.severity).toBe("pass");
    expect(cache.get("T8040001999011", "2026-03-15")?.valid).toBe(true);
    expect(cache.get("T8040001999011", "2020-01-01")).toBeNull();
  });

  it("queries once per registration number and date, but again for a different date", async () => {
    const counter = { calls: 0 };
    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: "T8040001999011", issueDate: "2026-03-15", amount: 3000 },
      { dealId: 2, regNumber: "T8040001999011", issueDate: "2026-03-15", amount: 5000 },
      { dealId: 3, regNumber: "T8040001999011", issueDate: "2026-04-01", amount: 5000 },
    ];
    await checkInvoiceRegistration(entries, cache, { appId, httpClient: httpReturning(ntaJson([activeEntry()]), counter) });
    expect(counter.calls).toBe(2);
  });

  it("warns when the issuer name on the receipt does not match the published name", async () => {
    const entries: InvoiceEntry[] = [
      { dealId: 1, regNumber: "T8040001999011", issueDate: "2026-03-15", amount: 3000, vendorName: "Amazon Japan" },
    ];
    const result = await checkInvoiceRegistration(entries, cache, { appId, httpClient: httpReturning(ntaJson([activeEntry()])) });
    expect(result.severity).toBe("warning");
    expect(result.items[0].reason).toContain("一致しない");
  });
});
