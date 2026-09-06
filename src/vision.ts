import type { Deal } from "../lib/freee/types.js";
import type { AuditItem, AuditResult } from "./checks.js";

export interface ReceiptOCR {
  amount: number | null;
  date: string | null;
  vendor: string | null;
  registration_number: string | null;
}

export interface DealWithOCR {
  deal: Deal;
  /** 取引に添付された証憑ごとの読取結果。読取失敗（応答を JSON として解釈できない等）は null。 */
  ocrs: Array<ReceiptOCR | null>;
  /** 1 回の実行あたりの上限により今回は読まなかった証憑の数。 */
  skipped: number;
}

/** Minimal interface for Anthropic message creation (testable). */
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

const VISION_PROMPT = `このレシート/領収書画像から以下の情報をJSON形式で抽出してください。

{
  "amount": <合計金額（税込、整数、日本円）>,
  "date": "<発行日 YYYY-MM-DD>",
  "vendor": "<発行元の名前>",
  "registration_number": "<適格請求書発行事業者の登録番号（T+13桁）、なければnull>"
}

金額が見つからない場合はnull、日付が見つからない場合はnullを返してください。
JSONのみ返してください。説明は不要です。`;

/** Extract amount/date/vendor from a receipt PDF using Claude Vision. */
export async function ocrReceipt(client: AnthropicLike, pdfContent: Buffer): Promise<ReceiptOCR | null> {
  const base64 = pdfContent.toString("base64");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          { type: "text", text: VISION_PROMPT },
        ],
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? (response.content[0].text ?? "") : "";
  return parseVisionResponse(text);
}

/**
 * Parse JSON from Vision API response text.
 * 形が ReceiptOCR として読めないもの（配列、数値以外の amount 等）は null＝読取失敗。
 */
export function parseVisionResponse(text: string): ReceiptOCR | null {
  const candidates = [text];
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fenced) candidates.push(fenced[1]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      const ocr = toReceiptOCR(parsed);
      if (ocr) return ocr;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function toReceiptOCR(v: unknown): ReceiptOCR | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const amount = typeof o.amount === "number" && Number.isFinite(o.amount) ? Math.round(o.amount) : null;
  const date = typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
  const vendor = typeof o.vendor === "string" && o.vendor.trim() ? o.vendor : null;
  const registration_number = typeof o.registration_number === "string" ? o.registration_number : null;
  return { amount, date, vendor, registration_number };
}

const DATE_TOLERANCE_DAYS = 3;

/**
 * E2: Check receipt OCR data against deal amounts/dates.
 *
 * 合格 / 不一致 / 読取失敗 / 未検証 を区別する。読取失敗と未検証は「問題なし」に
 * 含めず、summary に件数を出し severity を warning 以上にする。
 */
export function checkReceiptConsistency(pairs: DealWithOCR[]): AuditResult {
  const items: AuditItem[] = [];
  let verified = 0;
  let unreadable = 0;
  let unverified = 0;

  for (const { deal, ocrs, skipped } of pairs) {
    const base = { id: deal.id, date: deal.issue_date, amount: deal.amount };
    const readable = ocrs.filter((o): o is ReceiptOCR => o !== null);

    if (readable.length === 0) {
      if (ocrs.length > 0) {
        unreadable++;
        items.push({ ...base, level: "warning", reason: `証憑 ${ocrs.length} 件の読取に失敗（金額・日付を確認できず）` });
      } else if (skipped > 0) {
        unverified++;
      }
      continue;
    }
    verified++;
    if (skipped > 0) {
      items.push({ ...base, level: "info", reason: `証憑 ${skipped} 件は上限により未読（次回実行で継続）` });
    }

    const amounts = readable.map((o) => o.amount).filter((a): a is number => a !== null);
    if (amounts.length > 0 && !amounts.includes(deal.amount)) {
      const nearest = amounts.reduce((p, c) => (Math.abs(c - deal.amount) < Math.abs(p - deal.amount) ? c : p));
      items.push({
        ...base,
        description: `freee: ¥${deal.amount.toLocaleString()} vs レシート: ${amounts.map((a) => `¥${a.toLocaleString()}`).join(" / ")}`,
        level: "error",
        reason: `金額不一致 (差額: ¥${Math.abs(deal.amount - nearest).toLocaleString()})`,
      });
    }

    const dates = readable.map((o) => o.date).filter((d): d is string => d !== null);
    if (dates.length > 0) {
      const dealTime = new Date(deal.issue_date).getTime();
      const diffs = dates.map((d) => Math.abs((dealTime - new Date(d).getTime()) / 86_400_000));
      const best = Math.min(...diffs);
      if (best > DATE_TOLERANCE_DAYS) {
        items.push({
          ...base,
          description: `freee: ${deal.issue_date} vs レシート: ${dates.join(" / ")}`,
          level: "warning",
          reason: `日付不一致 (${Math.round(best)}日差)`,
        });
      }
    }
  }

  const errors = items.filter((i) => i.level === "error").length;
  const mismatches = items.filter((i) => i.level === "error" || (i.level === "warning" && i.reason?.startsWith("日付"))).length;
  const severity = errors > 0 ? "error" : unreadable > 0 || unverified > 0 || mismatches > 0 ? "warning" : "pass";
  const coverage = `対象 ${pairs.length} 件: 検証 ${verified} 件、読取失敗 ${unreadable} 件、未検証 ${unverified} 件`;
  const summary =
    mismatches > 0
      ? `${mismatches} 件の整合性問題を検出（${coverage}）`
      : unreadable > 0 || unverified > 0
        ? `検証済み分に不一致なし。ただし確認できていない取引あり（${coverage}）`
        : `レシートと取引の整合性に問題なし（${coverage}）`;

  return { check: "receipt_consistency", severity, summary, items };
}
