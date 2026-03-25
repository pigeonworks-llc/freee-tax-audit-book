import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verified_duplicates (
    deal_group    TEXT PRIMARY KEY,
    result        TEXT NOT NULL,
    checked_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export type DuplicateResult = "confirmed_dup" | "separate_txn";

export class DuplicateCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private toKey(ids: number[]): string {
    return [...ids].sort((a, b) => a - b).join(",");
  }

  get(ids: number[]): DuplicateResult | null {
    const row = this.db.prepare("SELECT result FROM verified_duplicates WHERE deal_group = ?").get(this.toKey(ids)) as
      | { result: string }
      | undefined;
    return (row?.result as DuplicateResult) ?? null;
  }

  set(ids: number[], result: DuplicateResult): void {
    this.db
      .prepare(
        `INSERT INTO verified_duplicates (deal_group, result)
         VALUES (?, ?)
         ON CONFLICT(deal_group) DO UPDATE SET result=excluded.result, checked_at=CURRENT_TIMESTAMP`,
      )
      .run(this.toKey(ids), result);
  }
}
