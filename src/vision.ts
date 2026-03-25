import type { Deal } from "@freee-automation/shared";
import type { AuditItem, AuditResult } from "./checks.js";

export interface ReceiptOCR {
  amount: number | null;
  date: string | null;
  vendor: string | null;
  registration_number: string | null;
}

export interface DealWithOCR {
  deal: Deal;
  ocr: ReceiptOCR | null;
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

  const text = response.content[0].type === "text" ? (response.content[0].text ?? "") : "";
  return parseVisionResponse(text);
}

/** Parse JSON from Vision API response text. */
export function parseVisionResponse(text: string): ReceiptOCR | null {
  try {
    return JSON.parse(text) as ReceiptOCR;
  } catch {
    const match = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
    if (match) {
      try {
        return JSON.parse(match[1]) as ReceiptOCR;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** E2: Check receipt OCR data against deal amounts/dates. */
export function checkReceiptConsistency(pairs: DealWithOCR[]): AuditResult {
  const items: AuditItem[] = [];

  for (const { deal, ocr } of pairs) {
    if (!ocr) continue;

    if (ocr.amount !== null && ocr.amount !== deal.amount) {
      items.push({
        id: deal.id,
        date: deal.issue_date,
        amount: deal.amount,
        description: `freee: ¥${deal.amount.toLocaleString()} vs レシート: ¥${ocr.amount.toLocaleString()}`,
        level: "error",
        reason: `金額不一致 (差額: ¥${Math.abs(deal.amount - ocr.amount).toLocaleString()})`,
      });
    }

    if (ocr.date !== null) {
      const dealDate = new Date(deal.issue_date);
      const ocrDate = new Date(ocr.date);
      const diffDays = Math.abs((dealDate.getTime() - ocrDate.getTime()) / 86_400_000);
      if (diffDays > 3) {
        items.push({
          id: deal.id,
          date: deal.issue_date,
          amount: deal.amount,
          description: `freee: ${deal.issue_date} vs レシート: ${ocr.date}`,
          level: "warning",
          reason: `日付不一致 (${Math.round(diffDays)}日差)`,
        });
      }
    }
  }

  const hasError = items.some((i) => i.level === "error");
  return {
    check: "receipt_consistency",
    severity: items.length === 0 ? "pass" : hasError ? "error" : "warning",
    summary: items.length === 0 ? "レシートと取引の整合性に問題なし" : `${items.length} 件の整合性問題を検出`,
    items,
  };
}
