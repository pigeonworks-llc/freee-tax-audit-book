import { describe, expect, it } from "vitest";
import { parseAuditRules, parseReceiptRules } from "./config.js";

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
    });
  });

  it("returns an empty object for an absent or malformed file", () => {
    expect(parseAuditRules({})).toEqual({});
    expect(parseAuditRules(null)).toEqual({});
  });
});
