import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FreeeClient } from "../lib/freee/client.js";
import type { Deal, WalletTransaction } from "../lib/freee/types.js";
import { describe, expect, it } from "vitest";
import { DuplicateCache } from "./duplicate-cache.js";
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

/** Two deals that group as a duplicate candidate, both with receipts attached. */
function makeDuplicatePair(): Deal[] {
  const base = (id: number) => ({
    id,
    company_id: 123,
    issue_date: "2025-08-15",
    type: "expense" as const,
    amount: 12000,
    details: [{ id, account_item_id: 100, tax_code: 2, amount: 12000, vat: 1200 }],
    receipts: [{ id: 10 + id }],
    payments: [
      { id, date: "2025-08-15", amount: 12000, from_walletable_type: "credit_card", from_walletable_id: 1 },
    ],
  });
  return [base(1), base(2)];
}

/** Vision that always answers "same transaction". */
function mockVisionSame() {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: '{"same_transaction": true, "reason": "同じ注文番号"}' }],
      }),
    },
  };
}

describe("runAudit: duplicate report level", () => {
  function depsFor(deals: Deal[], overrides: Partial<AuditDeps> = {}): AuditDeps {
    return {
      client: mockFreee(deals),
      startDate: "2025-07-01",
      endDate: "2025-08-31",
      period: "FY2025",
      now: new Date(2025, 7, 31),
      fullCheck: true, // キャッシュを無視して毎回 Vision 経路へ入れる
      dupCachePath: ":memory:",
      ...overrides,
    };
  }

  it("keeps Vision-confirmed duplicates at warning, not error", async () => {
    const deals = makeDuplicatePair();
    const deps = depsFor(deals, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal Vision stub for this path
      anthropic: mockVisionSame() as any,
    });

    const { results } = await runAudit(deps);
    const dupe = results.find((r) => r.check === "duplicate_deals");

    expect(dupe?.severity).toBe("warning");
    expect(dupe?.items[0].level).toBe("warning");
    // 判定の根拠は残す
    expect(dupe?.items[0].reason).toContain("Vision: 同一取引");
  });

  it("honours an explicit error level on the Vision path", async () => {
    const deals = makeDuplicatePair();
    const deps = depsFor(deals, {
      // biome-ignore lint/suspicious/noExplicitAny: minimal Vision stub for this path
      anthropic: mockVisionSame() as any,
      duplicateOptions: { level: "error" },
    });

    const { results } = await runAudit(deps);
    const dupe = results.find((r) => r.check === "duplicate_deals");

    expect(dupe?.severity).toBe("error");
    expect(dupe?.items[0].level).toBe("error");
  });

  it("keeps confirmed_dup cache hits at the configured level", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dup-level-cache-"));
    const cachePath = join(tmpDir, "duplicate-check.db");
    try {
      const seed = new DuplicateCache(cachePath);
      seed.set([1, 2], "confirmed_dup");
      seed.close();

      // E6 の invoice OCR も anthropic.messages.create を使うため、
      // 重複比較プロンプトだけを数える（invoice 経路と混同しない）。
      let duplicateVisionCalls = 0;
      const deals = makeDuplicatePair();
      const deps = depsFor(deals, {
        fullCheck: false,
        dupCachePath: cachePath,
        // biome-ignore lint/suspicious/noExplicitAny: minimal Vision stub for this path
        anthropic: {
          messages: {
            create: async (req: { messages?: Array<{ content?: unknown }> }) => {
              const blob = JSON.stringify(req.messages ?? []);
              if (blob.includes("same_transaction")) duplicateVisionCalls++;
              return { content: [{ type: "text", text: '{"same_transaction": true, "reason": "should not run"}' }] };
            },
          },
        } as any,
      });

      const { results } = await runAudit(deps);
      const dupe = results.find((r) => r.check === "duplicate_deals");

      expect(duplicateVisionCalls).toBe(0);
      expect(dupe?.severity).toBe("warning");
      expect(dupe?.items[0].level).toBe("warning");
      expect(dupe?.items[0].reason).toContain("重複確認済み");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports metadata matches at the configured level, not a hard-coded warning", async () => {
    const deals = makeDuplicatePair();
    const sameMeta = {
      partner_name: "NOMAD.LOVE",
      issue_date: "2025-08-15",
      amount: 12000,
    };
    const client = mockFreee(deals, {
      // Vision 経路に入らないよう PDF 取得を失敗させ、メタデータ比較へ落とす
      downloadReceipt: async () => {
        throw new Error("download unavailable");
      },
      getReceipt: async (id: number) => ({
        id,
        status: "confirmed",
        created_at: "2025-08-15",
        mime_type: "application/pdf",
        receipt_metadatum: sameMeta,
      }),
    });

    const deps = depsFor(deals, {
      client,
      // anthropic が無いと refine ブロック自体がスキップされるため、スタブだけ渡す
      // biome-ignore lint/suspicious/noExplicitAny: presence-only stub; Vision must not succeed
      anthropic: { messages: { create: async () => ({ content: [] }) } } as any,
      duplicateOptions: { level: "error" },
    });

    const { results } = await runAudit(deps);
    const dupe = results.find((r) => r.check === "duplicate_deals");

    expect(dupe?.severity).toBe("error");
    expect(dupe?.items[0].level).toBe("error");
    expect(dupe?.items[0].reason).toContain("メタデータ同一、要確認");
  });
});
