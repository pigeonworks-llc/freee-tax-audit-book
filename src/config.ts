import {
  DEFAULT_DUPLICATE_LEVEL,
  DEFAULT_RECEIPT_CHECK,
  type DuplicateCheckOptions,
  type ForeignVendor,
  type ReceiptCheckConfig,
  type ReceiptExemptionRules,
} from "./checks.js";

/** Shape of config/receipt-rules.yaml. */
interface RawReceiptRules {
  receipt_check?: {
    enabled?: boolean;
    unattached_level?: string;
  };
  receipt_exemptions?: {
    small_amount_threshold?: number;
    zero_amount_threshold?: number;
    exempt_account_items?: string[];
    exempt_account_categories?: string[];
    exempt_description_patterns?: string[];
  };
}

/** Shape of config/audit-rules.yaml. */
interface RawAuditRules {
  foreign_vendors?: Array<string | { pattern?: string; name?: string }>;
  duplicate_check?: {
    exclude_account_items?: string[];
    min_amount?: number;
    level?: string;
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
    exemptAccountCategories: ex.exempt_account_categories,
    exemptDescriptionPatterns: ex.exempt_description_patterns,
  };
}

const REPORT_LEVELS = new Set(["info", "warning", "error"]);

/**
 * Parse the `receipt_check` section of config/receipt-rules.yaml.
 * An absent section (older config files) keeps the default behaviour.
 */
export function parseReceiptCheckConfig(raw: unknown): ReceiptCheckConfig {
  if (!isRecord(raw)) return DEFAULT_RECEIPT_CHECK;
  const section = (raw as RawReceiptRules).receipt_check;
  if (!section) return DEFAULT_RECEIPT_CHECK;

  const level = section.unattached_level;
  if (level != null && !REPORT_LEVELS.has(level)) {
    console.error(
      `[tax-audit] receipt_check.unattached_level="${level}" is not info/warning/error; using ${DEFAULT_RECEIPT_CHECK.unattachedLevel}`,
    );
  }

  return {
    enabled: section.enabled ?? DEFAULT_RECEIPT_CHECK.enabled,
    unattachedLevel:
      level != null && REPORT_LEVELS.has(level)
        ? (level as ReceiptCheckConfig["unattachedLevel"])
        : DEFAULT_RECEIPT_CHECK.unattachedLevel,
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
    const level = duplicate_check.level;
    if (level != null && !REPORT_LEVELS.has(level)) {
      console.error(
        `[tax-audit] duplicate_check.level="${level}" is not info/warning/error; using ${DEFAULT_DUPLICATE_LEVEL}`,
      );
    }
    rules.duplicateOptions = {
      excludeAccountItems: duplicate_check.exclude_account_items,
      minAmount: duplicate_check.min_amount,
      level:
        level != null && REPORT_LEVELS.has(level)
          ? (level as NonNullable<DuplicateCheckOptions["level"]>)
          : DEFAULT_DUPLICATE_LEVEL,
    };
  }

  return rules;
}
