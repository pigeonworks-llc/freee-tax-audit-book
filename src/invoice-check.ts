import type { AuditItem, AuditResult } from "./checks.js";
import type { InvoiceCache, InvoiceValidity } from "./invoice-cache.js";

/**
 * 国税庁 適格請求書発行事業者公表システム Web-API。
 * 「登録番号と日付を指定して情報を取得する機能」(/1/valid) を使い、取引日を
 * 基準日として登録状況を照会する（Web-API 機能仕様書 第二編 §4）。
 */
const NTA_VALID_ENDPOINT = "https://web-api.invoice-kohyo.nta.go.jp/1/valid";

export interface InvoiceEntry {
  dealId: number;
  /** 証憑から抽出した登録番号。読み取れなかった場合は null。 */
  regNumber: string | null;
  /** 取引日 (YYYY-MM-DD)。この日を基準日として登録状況を照会する。 */
  issueDate: string;
  amount: number;
  /** 証憑から読み取った発行者名。公表名称との照合に使う。 */
  vendorName?: string | null;
  /** OCR 自体が失敗した（登録番号の有無を判定できていない）。 */
  ocrFailed?: boolean;
}

/**
 * /1/valid の JSON 応答（type=21）。仕様書 §4.3 ケース12 のとおり、
 * ヘッダ項目と公表情報配列が同じ階層に並ぶ。
 */
interface NtaValidResponse {
  count?: string;
  announcement?: Array<{
    registratedNumber?: string;
    /** 事業者処理区分: 01=新規, 02=変更, 03=登録の失効, 04=登録の取消 */
    process?: string;
    name?: string;
    registrationDate?: string;
    disposalDate?: string;
    expireDate?: string;
  }>;
}

/** Extract T+13-digit registration number from text. */
export function extractRegistrationNumber(text: string): string | null {
  // Handle full-width T (Ｔ) by normalizing first
  const normalized = text.replace(/Ｔ/g, "T");
  const match = /T(\d{13})(?!\d)/.exec(normalized);
  return match ? `T${match[1]}` : null;
}

export interface NtaQueryOptions {
  /** 国税庁から発行されたアプリケーション ID（13 桁）。 */
  appId: string;
  httpClient?: typeof fetch;
}

/**
 * 登録番号が基準日 `day` の時点で有効だったかを国税庁 API で照会する。
 * 通信・応答形式の異常は null（確認不能）。「公表なし」は valid=false。
 */
export async function queryNtaValidity(
  regNumber: string,
  day: string,
  options: NtaQueryOptions,
): Promise<InvoiceValidity | null> {
  const httpClient = options.httpClient ?? fetch;
  try {
    const params = new URLSearchParams({ id: options.appId, number: regNumber, day, type: "21" });
    const resp = await httpClient(`${NTA_VALID_ENDPOINT}?${params.toString()}`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as NtaValidResponse;
    if (typeof data.count !== "string" || !Array.isArray(data.announcement)) return null;

    const entry = data.announcement.find((a) => a.registratedNumber === regNumber) ?? data.announcement[0];
    if (Number.parseInt(data.count, 10) === 0 || !entry) {
      return { valid: false, name: null, basis: `${day} 時点で公表情報なし` };
    }

    const name = entry.name ?? null;
    if (entry.process === "03") {
      return { valid: false, name, basis: `登録の失効（失効日 ${entry.expireDate || "不明"}）` };
    }
    if (entry.process === "04") {
      return { valid: false, name, basis: `登録の取消（取消日 ${entry.disposalDate || "不明"}）` };
    }
    if (entry.registrationDate && entry.registrationDate > day) {
      return { valid: false, name, basis: `登録日 ${entry.registrationDate} より前の取引` };
    }
    if (entry.expireDate && entry.expireDate <= day) {
      return { valid: false, name, basis: `失効日 ${entry.expireDate} 以後の取引` };
    }
    if (entry.disposalDate && entry.disposalDate <= day) {
      return { valid: false, name, basis: `取消日 ${entry.disposalDate} 以後の取引` };
    }
    return { valid: true, name, basis: `${day} 時点で登録済み（登録日 ${entry.registrationDate ?? "不明"}）` };
  } catch {
    return null;
  }
}

/**
 * 証憑の発行者名と国税庁の公表名称を緩く照合する。
 * 法人格・空白・記号を落として、どちらかがもう一方を含めば一致とみなす。
 * どちらかが空なら判定しない（true）。
 */
export function issuerNameMatches(vendorName: string | null | undefined, ntaName: string | null): boolean {
  const a = normalizeIssuerName(vendorName ?? "");
  const b = normalizeIssuerName(ntaName ?? "");
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

function normalizeIssuerName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/株式会社|合同会社|有限会社|合資会社|合名会社|一般社団法人|\(株\)|\(有\)|\(同\)|㈱|㈲/g, "")
    .replace(/[\s　・･,.、。()（）\-ー－_]/g, "");
}

export interface InvoiceCheckOptions {
  /** 未設定なら国税庁 API を呼ばず、登録番号のある取引をすべて「確認不能」として報告する。 */
  appId?: string;
  httpClient?: typeof fetch;
}

/** E6: Check invoice registration numbers against NTA API as of each deal's issue date. */
export async function checkInvoiceRegistration(
  entries: InvoiceEntry[],
  cache: InvoiceCache,
  options: InvoiceCheckOptions = {},
): Promise<AuditResult> {
  const items: AuditItem[] = [];
  const checked = new Map<string, InvoiceValidity>();
  let confirmed = 0;

  for (const entry of entries) {
    const base = { id: entry.dealId, date: entry.issueDate, amount: entry.amount };

    if (entry.ocrFailed) {
      items.push({ ...base, level: "warning", reason: "証憑の読取に失敗（登録番号を確認できず）" });
      continue;
    }
    if (!entry.regNumber) {
      items.push({ ...base, level: "info", reason: "登録番号なし" });
      continue;
    }
    if (!options.appId) {
      items.push({
        ...base,
        description: entry.regNumber,
        level: "warning",
        reason: "国税庁 API 未設定（NTA_APP_ID）のため確認不能",
      });
      continue;
    }

    const key = `${entry.regNumber}|${entry.issueDate}`;
    let result = checked.get(key);
    if (!result) {
      const cached = cache.get(entry.regNumber, entry.issueDate);
      if (cached) {
        result = cached;
      } else {
        const apiResult = await queryNtaValidity(entry.regNumber, entry.issueDate, {
          appId: options.appId,
          httpClient: options.httpClient,
        });
        if (!apiResult) {
          items.push({
            ...base,
            description: entry.regNumber,
            level: "warning",
            reason: "国税庁 API 確認不能（通信エラーまたは応答形式不明）",
          });
          continue;
        }
        cache.set(entry.regNumber, entry.issueDate, apiResult);
        result = apiResult;
      }
      checked.set(key, result);
    }

    confirmed++;
    if (!result.valid) {
      items.push({
        ...base,
        description: `${entry.regNumber} (${result.name ?? "不明"})`,
        level: "error",
        reason: `取引日時点で登録番号が無効: ${result.basis}`,
      });
      continue;
    }
    if (!issuerNameMatches(entry.vendorName, result.name)) {
      items.push({
        ...base,
        description: `${entry.regNumber} (${result.name ?? "不明"})`,
        level: "warning",
        reason: `証憑の発行者名「${entry.vendorName}」が公表名称「${result.name}」と一致しない（屋号・表記揺れの可能性、要確認）`,
      });
    }
  }

  const errors = items.filter((i) => i.level === "error").length;
  const warnings = items.filter((i) => i.level === "warning").length;
  const noNumber = items.filter((i) => i.level === "info").length;
  const severity = errors > 0 ? "error" : warnings > 0 ? "warning" : "pass";

  const summary =
    errors > 0 || warnings > 0
      ? `${entries.length} 件中 ${confirmed} 件を国税庁 API で確認: 無効 ${errors} 件、要確認・確認不能 ${warnings} 件、登録番号なし ${noNumber} 件`
      : `${entries.length} 件中 ${confirmed} 件を国税庁 API で確認、登録番号に問題なし（登録番号なし ${noNumber} 件）`;

  return { check: "invoice_registration", severity, summary, items };
}
