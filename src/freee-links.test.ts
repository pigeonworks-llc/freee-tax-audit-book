import { describe, expect, it } from "vitest";
import { dealsFilterUrl, walletTxnUrl } from "./freee-links.js";

describe("walletTxnUrl", () => {
  it("links straight to the wallet transaction", () => {
    expect(walletTxnUrl(4321)).toBe("https://secure.freee.co.jp/wallet_txns/stream/4321");
  });
});

describe("dealsFilterUrl", () => {
  it("filters the deals list by both date and amount", () => {
    expect(dealsFilterUrl("2026-03-15", 3500)).toBe(
      "https://secure.freee.co.jp/deals/standards?issue_date=between_2026-03-15_2026-03-15&amount=between_3500_3500",
    );
  });

  it("returns an empty string when the date or amount is missing", () => {
    expect(dealsFilterUrl(undefined, 3500)).toBe("");
    expect(dealsFilterUrl("2026-03-15", undefined)).toBe("");
  });
});
