import Database from "better-sqlite3";

/**
 * 「登録番号 × 基準日」ごとの照会結果。基準日を分けるのは、同じ番号でも
 * 取引日によって登録前・失効後で判定が変わるため。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoice_validity (
    reg_number  TEXT NOT NULL,
    as_of_day   TEXT NOT NULL,
    valid       INTEGER NOT NULL,
    name        TEXT,
    basis       TEXT NOT NULL,
    checked_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (reg_number, as_of_day)
);
`;

const DEFAULT_TTL_DAYS = 90;

export interface InvoiceValidity {
  valid: boolean;
  name: string | null;
  /** 判定根拠（登録日・失効日・公表なし 等）。レポートにそのまま出す。 */
  basis: string;
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

  get(regNumber: string, asOfDay: string, ttlDays = DEFAULT_TTL_DAYS): InvoiceValidity | null {
    const row = this.db
      .prepare(
        `SELECT valid, name, basis FROM invoice_validity
         WHERE reg_number = ? AND as_of_day = ?
         AND checked_at > datetime('now', ?)`,
      )
      .get(regNumber, asOfDay, `-${ttlDays} days`) as
      | { valid: number; name: string | null; basis: string }
      | undefined;

    if (!row) return null;
    return { valid: row.valid === 1, name: row.name, basis: row.basis };
  }

  set(regNumber: string, asOfDay: string, result: InvoiceValidity): void {
    this.db
      .prepare(
        `INSERT INTO invoice_validity (reg_number, as_of_day, valid, name, basis)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(reg_number, as_of_day) DO UPDATE SET
           valid=excluded.valid,
           name=excluded.name,
           basis=excluded.basis,
           checked_at=CURRENT_TIMESTAMP`,
      )
      .run(regNumber, asOfDay, result.valid ? 1 : 0, result.name, result.basis);
  }
}
