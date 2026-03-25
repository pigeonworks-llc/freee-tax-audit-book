import type { AuditResult } from "./checks.js";

const FREEE_WALLET_TXN_URL = "https://secure.freee.co.jp/wallet_txns/stream";

export interface SheetData {
  details: Array<{
    name: string;
    rows: (string | number)[][];
  }>;
}

/** Build structured sheet data from audit results (details only). */
export function buildSheetData(
  results: AuditResult[],
  _period: string,
  dealToWalletTxnId?: Map<number, number>,
): SheetData {
  const details: SheetData["details"] = [];
  for (const r of results) {
    if (r.severity === "pass" || r.items.length === 0) continue;

    const header = ["ID", "freee URL", "日付", "金額", "説明", "レベル", "理由"];
    const rows: (string | number)[][] = [header];

    for (const item of r.items) {
      const ids = item.ids ?? [item.id];
      const urls = ids
        .map((id) => {
          const wtId = dealToWalletTxnId?.get(id);
          return wtId ? `${FREEE_WALLET_TXN_URL}/${wtId}` : "";
        })
        .filter(Boolean)
        .join("\n");
      rows.push([
        ids.join(","),
        urls,
        item.date ?? "",
        item.amount ?? "",
        item.description ?? "",
        item.level ?? "",
        item.reason ?? "",
      ]);
    }

    details.push({ name: r.check, rows });
  }

  return { details };
}

/** Convert SheetData to CSV strings for each sheet. */
export function sheetDataToCsv(data: SheetData): Map<string, string> {
  const csvMap = new Map<string, string>();

  const toCsv = (rows: (string | number)[][]) =>
    rows
      .map((row) =>
        row
          .map((cell) => {
            const s = String(cell);
            return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(","),
      )
      .join("\n");

  for (const detail of data.details) {
    csvMap.set(detail.name, toCsv(detail.rows));
  }

  return csvMap;
}
