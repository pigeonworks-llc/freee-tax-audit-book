import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountItem, Deal, FreeeToken, WalletTransaction } from "./types.js";
import type { Tenant } from "./tenant.js";

export interface TrialBalanceItem {
  account_item_id: number;
  account_item_name: string;
  account_category_name: string;
  parent_account_category_name?: string;
  hierarchy_level: number;
  opening_balance: number;
  debit_amount: number;
  credit_amount: number;
  closing_balance: number;
  composition_ratio?: number;
}

export interface TrialPlResponse {
  balances: TrialBalanceItem[];
}

export interface TrialBsResponse {
  balances: TrialBalanceItem[];
}

const TOKEN_ENDPOINT = "https://accounts.secure.freee.co.jp/public_api/token";
const TOKEN_EXPIRY_BUFFER_SEC = 300;

export type HttpClient = typeof fetch;
export type FileReader = (path: string) => string;
export type FileWriter = (path: string, content: string) => void;

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function defaultWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

export interface FreeeClientConfig {
  apiUrl: string;
  companyId: number;
  tokenPath?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  httpClient?: HttpClient;
  readFile?: FileReader;
  writeFile?: FileWriter;
}

export class FreeeClient {
  private apiUrl: string;
  private companyId: number;
  private tokenPath?: string;
  private clientId?: string;
  private clientSecret?: string;
  private accessToken?: string;
  private httpClient: HttpClient;
  private readFileFn: FileReader;
  private writeFileFn: FileWriter;
  private tokenLoaded = false;

  constructor(config: FreeeClientConfig) {
    this.apiUrl = config.apiUrl;
    this.companyId = config.companyId;
    this.tokenPath = config.tokenPath;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.accessToken = config.accessToken;
    this.httpClient = config.httpClient ?? fetch;
    this.readFileFn = config.readFile ?? defaultReadFile;
    this.writeFileFn = config.writeFile ?? defaultWriteFile;

    if (!this.accessToken && this.tokenPath) {
      this.loadTokenIfNeeded();
    } else {
      this.tokenLoaded = true;
    }
  }

  static fromTenant(
    tenant: Tenant,
    opts?: {
      clientId?: string;
      clientSecret?: string;
      httpClient?: HttpClient;
      readFile?: FileReader;
      writeFile?: FileWriter;
    },
  ): FreeeClient {
    return new FreeeClient({
      apiUrl: process.env.FREEE_API_URL ?? "https://api.freee.co.jp",
      companyId: tenant.companyId,
      tokenPath: tenant.tokenPath,
      clientId: opts?.clientId ?? process.env.FREEE_CLIENT_ID,
      clientSecret: opts?.clientSecret ?? process.env.FREEE_CLIENT_SECRET,
      httpClient: opts?.httpClient,
      readFile: opts?.readFile,
      writeFile: opts?.writeFile,
    });
  }

  isTokenExpired(expiresAt: number): boolean {
    return Date.now() / 1000 + TOKEN_EXPIRY_BUFFER_SEC > expiresAt;
  }

  private loadTokenFile(): FreeeToken {
    if (!this.tokenPath) throw new Error("tokenPath not configured");
    const data = this.readFileFn(this.tokenPath);
    return JSON.parse(data) as FreeeToken;
  }

  private saveTokenFile(token: FreeeToken): void {
    if (!this.tokenPath) return;
    this.writeFileFn(this.tokenPath, JSON.stringify(token, null, 2));
  }

  private loadTokenIfNeeded(): void {
    if (this.tokenLoaded || !this.tokenPath) return;
    this.tokenLoaded = true;
    try {
      const token = this.loadTokenFile();
      this.accessToken = token.access_token;
      if (!this.companyId) this.companyId = token.company_id;
    } catch {
      // Token file not found, will need manual setup.
    }
  }

  async ensureValidToken(): Promise<void> {
    this.loadTokenIfNeeded();
    if (!this.tokenPath || !this.clientId || !this.clientSecret) return;

    const token = this.loadTokenFile();
    if (!this.isTokenExpired(token.expires_at)) {
      this.accessToken = token.access_token;
      return;
    }

    console.error("[freee] Token expired, refreshing...");

    const resp = await this.httpClient(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: token.refresh_token,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const newToken: FreeeToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
      company_id: token.company_id,
    };

    this.saveTokenFile(newToken);
    this.accessToken = newToken.access_token;
    console.error(`[freee] Token refreshed, expires in ${data.expires_in}s`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    await this.ensureValidToken();
    const url = `${this.apiUrl}${path}`;
    const resp = await this.httpClient(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`freee API error (${resp.status}): ${text}`);
    }
    return (await resp.json()) as T;
  }

  async listCompanies(): Promise<{ id: number; name: string; display_name: string }[]> {
    const data = await this.request<{
      companies: { id: number; name: string; display_name: string }[];
    }>("/api/1/companies");
    return data.companies;
  }

  async listUnregisteredTransactions(): Promise<WalletTransaction[]> {
    const all: WalletTransaction[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const params = new URLSearchParams({
        company_id: String(this.companyId),
        status: "1",
        limit: String(limit),
        offset: String(offset),
      });
      const data = await this.request<{ wallet_txns: WalletTransaction[] }>(`/api/1/wallet_txns?${params}`);
      all.push(...data.wallet_txns);
      if (data.wallet_txns.length < limit) break;
      offset += limit;
    }

    return all;
  }

  async listAccountItems(): Promise<AccountItem[]> {
    const params = new URLSearchParams({
      company_id: String(this.companyId),
    });
    const data = await this.request<{ account_items: AccountItem[] }>(`/api/1/account_items?${params}`);
    return data.account_items;
  }

  async listDeals(params?: {
    start_issue_date?: string;
    end_issue_date?: string;
    type?: "income" | "expense";
  }): Promise<Deal[]> {
    const all: Deal[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const qp = new URLSearchParams({
        company_id: String(this.companyId),
        limit: String(limit),
        offset: String(offset),
      });
      if (params?.start_issue_date) qp.set("start_issue_date", params.start_issue_date);
      if (params?.end_issue_date) qp.set("end_issue_date", params.end_issue_date);
      if (params?.type) qp.set("type", params.type);

      const data = await this.request<{ deals: Deal[] }>(`/api/1/deals?${qp}`);
      all.push(...data.deals);
      if (data.deals.length < limit) break;
      offset += limit;
    }

    return all;
  }

  async listAllWalletTransactions(params?: { from_date?: string; to_date?: string }): Promise<WalletTransaction[]> {
    const all: WalletTransaction[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const qp = new URLSearchParams({
        company_id: String(this.companyId),
        limit: String(limit),
        offset: String(offset),
      });
      if (params?.from_date) qp.set("from_date", params.from_date);
      if (params?.to_date) qp.set("to_date", params.to_date);

      const data = await this.request<{ wallet_txns: WalletTransaction[] }>(`/api/1/wallet_txns?${qp}`);
      all.push(...data.wallet_txns);
      if (data.wallet_txns.length < limit) break;
      offset += limit;
    }

    return all;
  }

  async getCompany(): Promise<{
    id: number;
    display_name: string;
    fiscal_years?: Array<{ start_date: string }>;
  }> {
    const data = await this.request<{
      company: { id: number; display_name: string; fiscal_years?: Array<{ start_date: string }> };
    }>(`/api/1/companies/${this.companyId}`);
    return data.company;
  }

  async getTrialPl(fiscalYear: number, startMonth: number, endMonth: number): Promise<TrialPlResponse> {
    const qp = new URLSearchParams({
      company_id: String(this.companyId),
      fiscal_year: String(fiscalYear),
      start_month: String(startMonth),
      end_month: String(endMonth),
    });
    const data = await this.request<{ trial_pl: TrialPlResponse }>(`/api/1/reports/trial_pl?${qp}`);
    return data.trial_pl;
  }

  async getTrialBs(fiscalYear: number, startMonth: number, endMonth: number): Promise<TrialBsResponse> {
    const qp = new URLSearchParams({
      company_id: String(this.companyId),
      fiscal_year: String(fiscalYear),
      start_month: String(startMonth),
      end_month: String(endMonth),
    });
    const data = await this.request<{ trial_bs: TrialBsResponse }>(`/api/1/reports/trial_bs?${qp}`);
    return data.trial_bs;
  }

  async getReceipt(receiptId: number): Promise<{
    id: number;
    status: string;
    created_at: string;
    mime_type: string;
    receipt_metadatum?: {
      partner_name?: string;
      issue_date?: string;
      amount?: number;
    };
  }> {
    const qp = new URLSearchParams({ company_id: String(this.companyId) });
    const data = await this.request<{ receipt: Awaited<ReturnType<FreeeClient["getReceipt"]>> }>(
      `/api/1/receipts/${receiptId}?${qp}`,
    );
    return data.receipt;
  }

  async downloadReceipt(receiptId: number): Promise<Buffer> {
    await this.ensureValidToken();
    const resp = await this.httpClient(
      `${this.apiUrl}/api/1/receipts/${receiptId}/download?company_id=${this.companyId}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    if (!resp.ok) throw new Error(`Receipt download failed (${resp.status})`);
    return Buffer.from(await resp.arrayBuffer());
  }

  async uploadReceipt(filePath: string, issueDate?: string): Promise<number> {
    await this.ensureValidToken();
    const fileContent = readFileSync(filePath);
    const formData = new FormData();
    formData.append("company_id", String(this.companyId));
    formData.append("receipt", new Blob([fileContent], { type: "application/pdf" }), filePath.split("/").pop());
    if (issueDate) formData.append("issue_date", issueDate);

    const resp = await this.httpClient(`${this.apiUrl}/api/1/receipts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: formData,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Receipt upload failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as { receipt: { id: number } };
    return data.receipt.id;
  }
}
