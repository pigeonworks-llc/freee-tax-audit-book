#!/usr/bin/env node
/**
 * One-time freee OAuth setup.
 *
 * Prints the authorization URL, takes the code you get back, exchanges it for
 * a token pair, and writes the token file the audit run reads. After this the
 * client refreshes the token on its own — this script is only for the first
 * run and for re-authorising when the refresh token expires.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { FreeeToken } from "../lib/freee/types.js";

const AUTHORIZE_ENDPOINT = "https://accounts.secure.freee.co.jp/public_api/authorize";
const TOKEN_ENDPOINT = "https://accounts.secure.freee.co.jp/public_api/token";
/** freee apps registered without a redirect URI use this out-of-band value. */
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

export function buildAuthorizeUrl(clientId: string, redirectUri: string = REDIRECT_URI): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
  });
  return `${AUTHORIZE_ENDPOINT}?${params}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Exchange an authorization code for a token pair. */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string = REDIRECT_URI,
  httpClient: typeof fetch = fetch,
): Promise<TokenResponse> {
  const resp = await httpClient(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as TokenResponse;
}

export function toFreeeToken(resp: TokenResponse, companyId: number, now: number = Date.now()): FreeeToken {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: Math.floor(now / 1000) + resp.expires_in,
    company_id: companyId,
  };
}

async function main() {
  const clientId = process.env.FREEE_CLIENT_ID;
  const clientSecret = process.env.FREEE_CLIENT_SECRET;
  const companyId = Number(process.env.FREEE_COMPANY_ID);
  const tokenPath = resolve(process.env.FREEE_TOKEN_PATH ?? "token.json");

  const missing = [
    !clientId && "FREEE_CLIENT_ID",
    !clientSecret && "FREEE_CLIENT_SECRET",
    !companyId && "FREEE_COMPANY_ID",
  ].filter(Boolean);
  if (missing.length > 0 || !clientId || !clientSecret) {
    console.error(`[oauth-setup] Set ${missing.join(", ")} before running this.`);
    process.exit(1);
  }

  console.log("次の URL をブラウザで開き、freee にログインして認可してください:\n");
  console.log(`  ${buildAuthorizeUrl(clientId)}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = (await rl.question("表示された認可コードを貼り付けてください: ")).trim();
    if (!code) {
      console.error("[oauth-setup] No code entered.");
      process.exit(1);
    }

    const resp = await exchangeCode(code, clientId, clientSecret);
    const token = toFreeeToken(resp, companyId);

    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
    console.log(`\n[oauth-setup] Token written to ${tokenPath}`);
    console.log("[oauth-setup] 以降のトークン更新は自動で行われます。");
  } finally {
    rl.close();
  }
}

if (process.argv[1]?.endsWith("oauth-setup.ts") || process.argv[1]?.endsWith("oauth-setup.js")) {
  main().catch((err) => {
    console.error("[oauth-setup] Fatal:", err);
    process.exit(1);
  });
}
