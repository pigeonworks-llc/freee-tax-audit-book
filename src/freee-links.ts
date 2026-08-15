const FREEE_BASE = "https://secure.freee.co.jp";

/** Direct link to a bank/card statement line. */
export function walletTxnUrl(walletTxnId: number): string {
  return `${FREEE_BASE}/wallet_txns/stream/${walletTxnId}`;
}

/**
 * Link to the deals list filtered down to one deal.
 *
 * freee shows deal details in a modal, so `/deals/{id}` is a 404 — there is no
 * per-deal URL. Filtering the list by both issue date and amount narrows it to
 * (almost always) the single deal being reported, which is what makes a
 * few-hundred-row report workable.
 */
export function dealsFilterUrl(date: string | undefined, amount: number | undefined): string {
  if (!date || amount == null) return "";
  return `${FREEE_BASE}/deals/standards?issue_date=between_${date}_${date}&amount=between_${amount}_${amount}`;
}
