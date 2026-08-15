import type { FreeeClient } from "../lib/freee/client.js";
import type { Deal, WalletTransaction } from "../lib/freee/types.js";
import { describe, expect, it } from "vitest";
import { type AuditDeps, runAudit } from "./runner.js";

/** GET /api/1/deals returns account_item_id only — mirror that here. */
function makeDeals(): Deal[] {
  return [
    {
      id: 1,
      company_id: 123,
      issue_date: "2025-08-15",
      type: "expense",
      amount: 5000,
      details: [{ id: 1, account_item_id: 100, tax_code: 2, amount: 5000, vat: 500 }],
      receipts: [{ id: 10 }],
      payments: [
        { id: 1, date: "2025-08-15", amount: 5000, from_walletable_type: "credit_card", from_walletable_id: 1 },
      ],
    },
  ];
}

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

function mockFreee(deals: Deal[], overrides: Partial<Record<string, unknown>> = {}): FreeeClient {
  return {
    listDeals: async () => deals,
    listUnregisteredTransactions: async () => txns,
    listAllWalletTransactions: async () => txns,
    listAccountItems: async () => [{ id: 100, name: "消耗品費" }],
    listCompanyTaxes: async () => [
      { code: 2, name: "課税仕入（税率不明）" },
      { code: 21, name: "課税仕入 10%" },
      { code: 1, name: "課税売上 10%" },
    ],
    getReceipt: async () => ({ id: 10, status: "confirmed", created_at: "2025-08-15", mime_type: "application/pdf" }),
    downloadReceipt: async () => Buffer.from("fake-pdf"),
    ...overrides,
  } as unknown as FreeeClient;
}

function makeDeps(client: FreeeClient): AuditDeps {
  return {
    client,
    startDate: "2025-07-01",
    endDate: "2025-08-31",
    period: "FY2025",
    now: new Date(2025, 7, 31),
    fullCheck: false,
    dupCachePath: ":memory:",
  };
}

describe("runAudit", () => {
  it("produces audit results with 4 checks", async () => {
    const { results, report, dealToWalletTxnId } = await runAudit(makeDeps(mockFreee(makeDeals())));
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(report.markdown).toContain("FY2025");
    expect(dealToWalletTxnId.size).toBe(1);
  });

  it("fills in account_item_name from the account item master", async () => {
    const deals = makeDeals();
    await runAudit(makeDeps(mockFreee(deals)));
    expect(deals[0].details[0].account_item_name).toBe("消耗品費");
  });

  it("continues when the account item master is unavailable", async () => {
    const deals = makeDeals();
    const client = mockFreee(deals, {
      listAccountItems: async () => {
        throw new Error("403 Forbidden");
      },
    });

    const { results } = await runAudit(makeDeps(client));
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(deals[0].details[0].account_item_name).toBeUndefined();
  });
});
