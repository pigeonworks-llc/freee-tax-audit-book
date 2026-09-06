import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceCache } from "./invoice-cache.js";

describe("InvoiceCache", () => {
  let cache: InvoiceCache;
  let tmpDir: string;
  const ok = { valid: true, name: "株式会社テスト", basis: "2026-03-15 時点で登録済み" };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "invoice-cache-"));
    cache = new InvoiceCache(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for unknown registration number", () => {
    expect(cache.get("T1234567890123", "2026-03-15")).toBeNull();
  });

  it("stores and retrieves an entry with its basis", () => {
    cache.set("T1234567890123", "2026-03-15", ok);
    expect(cache.get("T1234567890123", "2026-03-15")).toEqual(ok);
  });

  it("keys by as-of day so different deal dates are distinct", () => {
    cache.set("T1234567890123", "2026-03-15", ok);
    cache.set("T1234567890123", "2023-09-01", { valid: false, name: "株式会社テスト", basis: "登録日より前" });
    expect(cache.get("T1234567890123", "2026-03-15")?.valid).toBe(true);
    expect(cache.get("T1234567890123", "2023-09-01")?.valid).toBe(false);
    expect(cache.get("T1234567890123", "2024-01-01")).toBeNull();
  });

  it("overwrites existing entry", () => {
    cache.set("T1234567890123", "2026-03-15", ok);
    cache.set("T1234567890123", "2026-03-15", { valid: false, name: "新名称", basis: "登録の取消" });
    expect(cache.get("T1234567890123", "2026-03-15")).toEqual({ valid: false, name: "新名称", basis: "登録の取消" });
  });

  it("returns null for expired entry", () => {
    cache.set("T1234567890123", "2026-03-15", ok);
    expect(cache.get("T1234567890123", "2026-03-15", 0)).toBeNull();
  });
});
