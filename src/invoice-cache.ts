import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoice_registrations (
    reg_number  TEXT PRIMARY KEY,
    valid       INTEGER NOT NULL,
    name        TEXT,
    checked_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

const DEFAULT_TTL_DAYS = 90;

export interface InvoiceCacheEntry {
  valid: boolean;
  name: string | null;
}

export class InvoiceCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  get(regNumber: string, ttlDays = DEFAULT_TTL_DAYS): InvoiceCacheEntry | null {
    const row = this.db
      .prepare(
        `SELECT valid, name FROM invoice_registrations
         WHERE reg_number = ?
         AND checked_at > datetime('now', ?)`,
      )
      .get(regNumber, `-${ttlDays} days`) as { valid: number; name: string | null } | undefined;

    if (!row) return null;
    return { valid: row.valid === 1, name: row.name };
  }

  set(regNumber: string, valid: boolean, name?: string): void {
    this.db
      .prepare(
        `INSERT INTO invoice_registrations (reg_number, valid, name)
         VALUES (?, ?, ?)
         ON CONFLICT(reg_number) DO UPDATE SET
           valid=excluded.valid,
           name=excluded.name,
           checked_at=CURRENT_TIMESTAMP`,
      )
      .run(regNumber, valid ? 1 : 0, name ?? null);
  }
}
