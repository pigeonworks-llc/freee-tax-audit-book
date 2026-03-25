import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

export interface Tenant {
  id: string;
  companyId: number;
  displayName: string;
  tokenPath: string;
  fiscalStartMonth: number;
  sheetsSpreadsheetId?: string;
  googleChatWebhook?: string;
}

interface RawTenant {
  id: string;
  company_id: number;
  display_name: string;
  token_path: string;
  fiscal_start_month: number;
  sheets_spreadsheet_id?: string;
  google_chat_webhook?: string;
}

interface RawConfig {
  tenants: RawTenant[];
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return `${homedir()}${p.slice(1)}`;
  }
  return p;
}

function rawToTenant(raw: RawTenant): Tenant {
  return {
    id: raw.id,
    companyId: raw.company_id,
    displayName: raw.display_name,
    tokenPath: expandHome(raw.token_path),
    fiscalStartMonth: raw.fiscal_start_month,
    sheetsSpreadsheetId: raw.sheets_spreadsheet_id,
    googleChatWebhook: raw.google_chat_webhook,
  };
}

/** Parse tenants from YAML string. */
export function parseTenants(yamlContent: string): Tenant[] {
  const config = parseYaml(yamlContent) as RawConfig;
  if (!config?.tenants || !Array.isArray(config.tenants)) {
    throw new Error("Invalid tenants config: missing 'tenants' array");
  }
  return config.tenants.map(rawToTenant);
}

/** Load tenants from a YAML file. */
export function loadTenants(configPath?: string): Tenant[] {
  const path = configPath ?? process.env.TENANTS_CONFIG ?? "config/tenants.yaml";
  const content = readFileSync(path, "utf-8");
  return parseTenants(content);
}

/** Get a tenant by ID. Throws if not found. */
export function getTenant(tenants: Tenant[], id: string): Tenant {
  const tenant = tenants.find((t) => t.id === id);
  if (!tenant) {
    const available = tenants.map((t) => t.id).join(", ");
    throw new Error(`Tenant "${id}" not found. Available: ${available}`);
  }
  return tenant;
}

/** Get the default tenant (first one, or FREEE_TENANT env). */
export function getDefaultTenant(tenants: Tenant[]): Tenant {
  const envId = process.env.FREEE_TENANT;
  if (envId) {
    return getTenant(tenants, envId);
  }
  if (tenants.length === 0) {
    throw new Error("No tenants configured");
  }
  return tenants[0];
}
