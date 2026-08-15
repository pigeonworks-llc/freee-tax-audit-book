import type { DuplicateCheckOptions, ForeignVendor, ReceiptExemptionRules } from "./checks.js";

/** Shape of config/receipt-rules.yaml. */
interface RawReceiptRules {
  receipt_exemptions?: {
    small_amount_threshold?: number;
    zero_amount_threshold?: number;
    exempt_account_items?: string[];
  };
}

/** Shape of config/audit-rules.yaml. */
interface RawAuditRules {
  foreign_vendors?: Array<string | { pattern?: string; name?: string }>;
  duplicate_check?: {
    exclude_account_items?: string[];
    min_amount?: number;
  };
}

/** Parsed config/audit-rules.yaml, in the shape runAudit() takes. */
export interface AuditRules {
  foreignVendors?: ForeignVendor[];
  duplicateOptions?: DuplicateCheckOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse config/receipt-rules.yaml. Returns undefined when the file has no rules. */
export function parseReceiptRules(raw: unknown): ReceiptExemptionRules | undefined {
  if (!isRecord(raw)) return undefined;
  const { receipt_exemptions: ex } = raw as RawReceiptRules;
  if (!ex) return undefined;
  return {
    smallAmountThreshold: ex.small_amount_threshold,
    zeroAmountThreshold: ex.zero_amount_threshold,
    exemptAccountItems: ex.exempt_account_items,
  };
}

/**
 * Parse config/audit-rules.yaml. Every section is optional; an absent section
 * leaves that check on its built-in default.
 */
export function parseAuditRules(raw: unknown): AuditRules {
  if (!isRecord(raw)) return {};
  const { foreign_vendors, duplicate_check } = raw as RawAuditRules;
  const rules: AuditRules = {};

  if (Array.isArray(foreign_vendors)) {
    const vendors: ForeignVendor[] = [];
    for (const entry of foreign_vendors) {
      if (typeof entry === "string") {
        vendors.push(entry);
      } else if (isRecord(entry) && typeof entry.pattern === "string") {
        vendors.push({ pattern: entry.pattern, name: entry.name });
      }
    }
    if (vendors.length > 0) rules.foreignVendors = vendors;
  }

  if (duplicate_check) {
    rules.duplicateOptions = {
      excludeAccountItems: duplicate_check.exclude_account_items,
      minAmount: duplicate_check.min_amount,
    };
  }

  return rules;
}
