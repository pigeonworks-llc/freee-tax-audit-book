import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceCache } from "./invoice-cache.js";

describe("InvoiceCache", () => {
  let cache: InvoiceCache;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "invoice-cache-"));
    cache = new InvoiceCache(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for unknown registration number", () => {
    expect(cache.get("T1234567890123")).toBeNull();
  });

  it("stores and retrieves valid entry", () => {
    cache.set("T1234567890123", true, "株式会社テスト");
    const entry = cache.get("T1234567890123");
    expect(entry).toEqual({ valid: true, name: "株式会社テスト" });
  });

  it("stores and retrieves invalid entry", () => {
    cache.set("T9999999999999", false);
    const entry = cache.get("T9999999999999");
    expect(entry).toEqual({ valid: false, name: null });
  });

  it("overwrites existing entry", () => {
    cache.set("T1234567890123", true, "旧名称");
    cache.set("T1234567890123", false, "新名称");
    const entry = cache.get("T1234567890123");
    expect(entry).toEqual({ valid: false, name: "新名称" });
  });

  it("returns null for expired entry", () => {
    cache.set("T1234567890123", true, "株式会社テスト");
    // TTL 0 days means everything is expired
    expect(cache.get("T1234567890123", 0)).toBeNull();
  });

  it("returns entry within TTL", () => {
    cache.set("T1234567890123", true, "株式会社テスト");
    // TTL 90 days - just inserted so should be valid
    const entry = cache.get("T1234567890123", 90);
    expect(entry).toEqual({ valid: true, name: "株式会社テスト" });
  });
});
