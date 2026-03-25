import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateCache } from "./duplicate-cache.js";

describe("DuplicateCache", () => {
  let cache: DuplicateCache;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dup-cache-"));
    cache = new DuplicateCache(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for unknown group", () => {
    expect(cache.get([1, 2])).toBeNull();
  });

  it("stores and retrieves result", () => {
    cache.set([3, 1, 2], "separate_txn");
    // Key should be sorted: "1,2,3"
    expect(cache.get([2, 1, 3])).toBe("separate_txn");
  });

  it("overwrites existing result", () => {
    cache.set([1, 2], "separate_txn");
    cache.set([1, 2], "confirmed_dup");
    expect(cache.get([1, 2])).toBe("confirmed_dup");
  });
});
