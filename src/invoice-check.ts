import type { AuditItem, AuditResult } from "./checks.js";
import type { InvoiceCache } from "./invoice-cache.js";

const NTA_API_BASE = "https://web-api.invoice-kohyo.nta.go.jp/1/num";

export interface InvoiceEntry {
  dealId: number;
  regNumber: string | null;
  issueDate: string;
  amount: number;
}

interface NtaResponse {
  announcement: {
    count: string;
    announcement: Array<{
      registratedNumber: string;
      process: string;
      name: string;
      registrationDate?: string;
    }>;
  };
}

/** Extract T+13-digit registration number from text. */
export function extractRegistrationNumber(text: string): string | null {
  // Handle full-width T (Ｔ) by normalizing first
  const normalized = text.replace(/Ｔ/g, "T");
  const match = /T(\d{13})(?!\d)/.exec(normalized);
  return match ? `T${match[1]}` : null;
}

/** Query the NTA qualified invoice issuer publication API. */
export async function queryNtaApi(
  regNumber: string,
  httpClient: typeof fetch = fetch,
): Promise<{ valid: boolean; name: string | null } | null> {
  try {
    const url = `${NTA_API_BASE}?id=${encodeURIComponent(regNumber)}&type=21&history=0`;
    const resp = await httpClient(url);
    if (!resp.ok) return null;

    const data = (await resp.json()) as NtaResponse;
    const count = Number.parseInt(data.announcement.count, 10);
    if (count === 0) {
      return { valid: false, name: null };
    }

    const entry = data.announcement.announcement[0];
    // process: 01=新規, 02=変更, 99=失効
    const valid = entry.process !== "99";
    return { valid, name: entry.name };
  } catch {
    return null;
  }
}

/** E6: Check invoice registration numbers against NTA API. */
export async function checkInvoiceRegistration(
  entries: InvoiceEntry[],
  cache: InvoiceCache,
  httpClient?: typeof fetch,
): Promise<AuditResult> {
  const items: AuditItem[] = [];
  const checked = new Map<string, { valid: boolean; name: string | null }>();

  for (const entry of entries) {
    if (!entry.regNumber) {
      items.push({
        id: entry.dealId,
        date: entry.issueDate,
        amount: entry.amount,
        level: "info",
        reason: "登録番号なし",
      });
      continue;
    }

    // Deduplicate: skip if already checked in this run
    let result = checked.get(entry.regNumber);
    if (!result) {
      // Check cache
      const cached = cache.get(entry.regNumber);
      if (cached) {
        result = cached;
      } else {
        // Query NTA API
        const apiResult = await queryNtaApi(entry.regNumber, httpClient);
        if (apiResult) {
          cache.set(entry.regNumber, apiResult.valid, apiResult.name ?? undefined);
          result = apiResult;
        } else {
          items.push({
            id: entry.dealId,
            date: entry.issueDate,
            amount: entry.amount,
            description: entry.regNumber,
            level: "warning",
            reason: "NTA API 確認不能",
          });
          continue;
        }
      }
      checked.set(entry.regNumber, result);
    }

    if (!result.valid) {
      items.push({
        id: entry.dealId,
        date: entry.issueDate,
        amount: entry.amount,
        description: `${entry.regNumber} (${result.name ?? "不明"})`,
        level: "error",
        reason: "登録番号が無効または失効",
      });
    }
  }

  const errors = items.filter((i) => i.level === "error");
  const warnings = items.filter((i) => i.level === "warning");
  const hasError = errors.length > 0;
  const hasWarning = warnings.length > 0;

  return {
    check: "invoice_registration",
    severity: hasError ? "error" : hasWarning ? "warning" : "pass",
    summary:
      hasError || hasWarning
        ? `${errors.length} 件の無効な登録番号、${warnings.length} 件の確認不能`
        : "インボイス登録番号に問題なし",
    items,
  };
}
