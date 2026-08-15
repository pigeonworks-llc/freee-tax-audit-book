/** freee wallet transaction (bank/credit card statement). */
export interface WalletTransaction {
  id: number;
  company_id: number;
  date: string; // YYYY-MM-DD
  amount: number; // Absolute value in JPY
  due_amount: number; // 0 = settled, >0 = unregistered
  balance: number;
  entry_side: "income" | "expense";
  walletable_type: "bank_account" | "credit_card";
  walletable_id: number;
  description: string;
  status: number; // 1=unregistered, 2=registered
}

/** freee account item. */
export interface AccountItem {
  id: number;
  name: string;
  tax_code?: number;
  account_category?: string;
}

/** freee deal (transaction). */
export interface Deal {
  id: number;
  company_id: number;
  issue_date: string;
  type: "income" | "expense";
  amount: number;
  due_amount?: number;
  /** 取引先 ID。経費取引では未設定のことが多い。 */
  partner_id?: number;
  details: DealDetail[];
  payments?: DealPayment[];
  receipts?: { id: number }[];
}

export interface DealDetail {
  id: number;
  account_item_id: number;
  /**
   * GET /api/1/deals は account_item_id のみを返すため、API レスポンス上は常に未設定。
   * enrichAccountItemNames() で account_items から補完する。
   */
  account_item_name?: string;
  tax_code: number;
  amount: number;
  vat: number;
  description?: string;
}

export interface DealPayment {
  id: number;
  date: string;
  amount: number;
  from_walletable_type: string;
  from_walletable_id: number;
}

/** freee receipt (file box item). */
export interface Receipt {
  id: number;
  status: string;
  description: string;
  issue_date?: string;
  mime_type: string;
  origin: string;
  receipt_metadatum?: {
    partner_name?: string;
    issue_date?: string;
    amount?: number;
  };
}

/** freee OAuth token file structure. */
export interface FreeeToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp
  company_id: number;
}

/**
 * Tax category available for a company.
 * Source: GET /api/1/taxes/companies/{company_id}
 * Prefer this over the deprecated GET /api/1/taxes/codes.
 */
export interface CompanyTax {
  /** tax_code used on deal details */
  code: number;
  name: string;
  name_ja?: string;
}
