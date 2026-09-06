import Database from "better-sqlite3";
import type { ReceiptOCR } from "./vision.js";

/**
 * 証憑 (receipt_id) ごとの OCR 結果。Vision API の呼び出しは有料なので、
 * 一度読んだ証憑は再実行時に読み直さない。これにより 1 回あたりの上限
 * (VISION_MAX_RECEIPTS) は「新規に OCR する件数」の上限になり、複数回の実行で
 * 全件に到達できる。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipt_ocr (
    receipt_id  INTEGER PRIMARY KEY,
    ocr_json    TEXT,
    failed      INTEGER NOT NULL DEFAULT 0,
    checked_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export interface OcrCacheEntry {
  /** 読取結果。読取失敗 (failed=1) のときは null。 */
  ocr: ReceiptOCR | null;
  failed: boolean;
}

export class OcrCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  get(receiptId: number): OcrCacheEntry | null {
    const row = this.db.prepare("SELECT ocr_json, failed FROM receipt_ocr WHERE receipt_id = ?").get(receiptId) as
      | { ocr_json: string | null; failed: number }
      | undefined;
    if (!row) return null;
    return { ocr: row.ocr_json ? (JSON.parse(row.ocr_json) as ReceiptOCR) : null, failed: row.failed === 1 };
  }

  /** 読取成功のみ保存する。失敗は次回もう一度読みに行く。 */
  set(receiptId: number, ocr: ReceiptOCR): void {
    this.db
      .prepare(
        `INSERT INTO receipt_ocr (receipt_id, ocr_json, failed) VALUES (?, ?, 0)
         ON CONFLICT(receipt_id) DO UPDATE SET ocr_json=excluded.ocr_json, failed=0, checked_at=CURRENT_TIMESTAMP`,
      )
      .run(receiptId, JSON.stringify(ocr));
  }
}
