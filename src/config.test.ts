import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { checkTaxCategory } from "./checks.js";
import { parseAuditRules, parseReceiptCheckConfig, parseReceiptRules } from "./config.js";
import type { Deal } from "../lib/freee/types.js";

describe("parseReceiptRules", () => {
  it("maps yaml keys to rule fields", () => {
    const rules = parseReceiptRules({
      receipt_exemptions: {
        small_amount_threshold: 10000,
        zero_amount_threshold: 1,
        exempt_account_items: ["旅費交通費"],
      },
    });
    expect(rules).toEqual({
      smallAmountThreshold: 10000,
      zeroAmountThreshold: 1,
      exemptAccountItems: ["旅費交通費"],
    });
  });

  it("returns undefined when the section is absent", () => {
    expect(parseReceiptRules({})).toBeUndefined();
    expect(parseReceiptRules(null)).toBeUndefined();
  });
});

describe("parseAuditRules", () => {
  it("reads plain string vendors", () => {
    const rules = parseAuditRules({ foreign_vendors: ["aws", "github"] });
    expect(rules.foreignVendors).toEqual(["aws", "github"]);
  });

  it("reads pattern/name vendor entries", () => {
    const rules = parseAuditRules({
      foreign_vendors: [{ pattern: "google\\s*cloud", name: "Google Cloud" }],
    });
    expect(rules.foreignVendors).toEqual([{ pattern: "google\\s*cloud", name: "Google Cloud" }]);
  });

  it("skips malformed vendor entries", () => {
    const rules = parseAuditRules({ foreign_vendors: ["aws", { name: "no pattern" }, 42] });
    expect(rules.foreignVendors).toEqual(["aws"]);
  });

  it("reads duplicate check tuning", () => {
    const rules = parseAuditRules({
      duplicate_check: { exclude_account_items: ["旅費交通費"], min_amount: 1000 },
    });
    expect(rules.duplicateOptions).toEqual({
      excludeAccountItems: ["旅費交通費"],
      minAmount: 1000,
      level: "warning",
    });
  });

  it("returns an empty object for an absent or malformed file", () => {
    expect(parseAuditRules({})).toEqual({});
    expect(parseAuditRules(null)).toEqual({});
  });
});

describe("同梱 config/audit-rules.yaml の foreign_vendors", () => {
  const rules = parseAuditRules(parse(readFileSync(resolve("config/audit-rules.yaml"), "utf-8")));
  const deal = (description: string): Deal => ({
    id: 1,
    company_id: 1,
    issue_date: "2026-04-01",
    amount: 3000,
    type: "expense",
    details: [{ id: 1, account_item_id: 1, tax_code: 21, amount: 3000, vat: 0, description }],
  });

  // カード明細に実際に現れる表記。全角・請求代行・サフィックス付きでも拾えること。
  it.each([
    ["OPENAI *CHATGPT SUBSCR", "openai"],
    ["Ａｐｐｌｅ　ｉＴｕｎｅｓ　Ｓｔｏｒｅ", "Apple / iTunes"],
    ["GARMIN (EUROPE) LIMITED", "Garmin"],
    ["AUDIBLE*NU7ZU01Z1", "audible"],
    ["CRAFT DOCS", "Craft Docs"],
    ["SUNO INC.", "suno"],
    ["UDEMYJP", "udemy"],
    ["D J*WSJ", "Dow Jones / WSJ"],
    ["PAYPAL *PRAGPROG BK", "paypal"],
    ["アマゾンサービシーズインターナショナル", "Amazon Services International"],
  ])("%s を海外ベンダーとして検出する", (description, vendor) => {
    const result = checkTaxCategory([deal(description)], rules.foreignVendors ?? []);
    expect(result.severity).toBe("warning");
    expect(result.items[0]?.matchedVendor).toBe(vendor);
  });

  // 国内法人からの請求は対象外。ここが warning になると偽陽性でノイズになる。
  it.each([
    "インターネットイニシアティブ　－東京都",
    "ＧＭＯオフィスサポ－ト　東京都　渋谷区",
    "ＯＲｅｉｌｌｙ　Ｊａｐａｎ　Ｅｂｏｏｋ",
    "ＭｏｎｏｔａＲＯ．ｃｏｍ",
    "ユウビン",
  ])("%s は国内取引として検出しない", (description) => {
    const result = checkTaxCategory([deal(description)], rules.foreignVendors ?? []);
    expect(result.severity).toBe("pass");
  });
});

describe("parseReceiptCheckConfig", () => {
  it("reads the receipt_check section", () => {
    expect(parseReceiptCheckConfig({ receipt_check: { enabled: false, unattached_level: "info" } })).toEqual({
      enabled: false,
      unattachedLevel: "info",
    });
  });

  it("defaults to enabled/warning when the section is absent", () => {
    expect(parseReceiptCheckConfig({ receipt_exemptions: {} })).toEqual({
      enabled: true,
      unattachedLevel: "warning",
    });
  });

  it("falls back to warning for an unknown level", () => {
    expect(parseReceiptCheckConfig({ receipt_check: { unattached_level: "fatal" } }).unattachedLevel).toBe("warning");
  });
});

describe("parseReceiptRules: 性質ベース免除", () => {
  it("reads category and description exemptions", () => {
    const rules = parseReceiptRules({
      receipt_exemptions: {
        exempt_account_categories: ["事業主"],
        exempt_description_patterns: ["振込手数料"],
      },
    });
    expect(rules?.exemptAccountCategories).toEqual(["事業主"]);
    expect(rules?.exemptDescriptionPatterns).toEqual(["振込手数料"]);
  });

  it("still reads the legacy small_amount_threshold key", () => {
    const rules = parseReceiptRules({ receipt_exemptions: { small_amount_threshold: 10000 } });
    expect(rules?.smallAmountThreshold).toBe(10000);
  });
});

describe("parseAuditRules: duplicate_check.level", () => {
  it("defaults to warning when the level is absent", () => {
    const rules = parseAuditRules({ duplicate_check: { min_amount: 1000 } });
    expect(rules.duplicateOptions?.level).toBe("warning");
  });

  it("reads an explicit level", () => {
    expect(parseAuditRules({ duplicate_check: { level: "error" } }).duplicateOptions?.level).toBe("error");
    expect(parseAuditRules({ duplicate_check: { level: "info" } }).duplicateOptions?.level).toBe("info");
  });

  it("falls back to warning for an unknown level", () => {
    expect(parseAuditRules({ duplicate_check: { level: "fatal" } }).duplicateOptions?.level).toBe("warning");
  });
});
