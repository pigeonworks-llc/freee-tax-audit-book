import type { FreeeClient } from "../lib/freee/client.js";
import type { Deal, WalletTransaction } from "../lib/freee/types.js";
import { describe, expect, it } from "vitest";
import { type AuditDeps, runAudit } from "./runner.js";

const deals: Deal[] = [
  {
    id: 1,
    company_id: 123,
    issue_date: "2025-08-15",
    type: "expense",
    amount: 5000,
    details: [{ id: 1, account_item_id: 100, account_item_name: "消耗品費", tax_code: 2, amount: 5000, vat: 500 }],
    receipts: [{ id: 10 }],
    payments: [{ id: 1, date: "2025-08-15", amount: 5000, from_walletable_type: "credit_card", from_walletable_id: 1 }],
  },
];

const txns: WalletTransaction[] = [
  {
    id: 100,
    company_id: 123,
    date: "2025-08-15",
    amount: 5000,
    due_amount: 5000,
    balance: 0,
    entry_side: "expense",
    walletable_type: "credit_card",
    walletable_id: 1,
    description: "test",
    status: 1,
  },
];

function mockFreee(): FreeeClient {
  return {
    listDeals: async () => deals,
    listUnregisteredTransactions: async () => txns,
    listAllWalletTransactions: async () => txns,
    listCompanyTaxes: async () => [
      { code: 2, name: "課税仕入（税率不明）" },
      { code: 21, name: "課税仕入 10%" },
      { code: 1, name: "課税売上 10%" },
    ],
    getReceipt: async () => ({ id: 10, status: "confirmed", created_at: "2025-08-15", mime_type: "application/pdf" }),
    downloadReceipt: async () => Buffer.from("fake-pdf"),
  } as unknown as FreeeClient;
}

describe("runAudit", () => {
  it("produces audit results with 4 checks", async () => {
    const deps: AuditDeps = {
      client: mockFreee(),
      startDate: "2025-07-01",
      endDate: "2025-08-31",
      period: "FY2025",
      now: new Date(2025, 7, 31),
      fullCheck: false,
      dupCachePath: ":memory:",
    };

    const { results, report, dealToWalletTxnId } = await runAudit(deps);
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(report.markdown).toContain("FY2025");
    expect(dealToWalletTxnId.size).toBe(1);
  });
});
