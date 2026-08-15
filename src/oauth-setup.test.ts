import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, exchangeCode, toFreeeToken } from "./oauth-setup.js";

describe("buildAuthorizeUrl", () => {
  it("includes the client id and the out-of-band redirect", () => {
    const url = new URL(buildAuthorizeUrl("client-abc"));
    expect(url.origin + url.pathname).toBe("https://accounts.secure.freee.co.jp/public_api/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("urn:ietf:wg:oauth:2.0:oob");
  });
});

describe("exchangeCode", () => {
  it("posts the authorization code and returns the token pair", async () => {
    let body: URLSearchParams | undefined;
    const httpClient = (async (_url: string, init?: RequestInit) => {
      body = init?.body as URLSearchParams;
      return {
        ok: true,
        json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 86400 }),
      };
    }) as unknown as typeof fetch;

    const resp = await exchangeCode("the-code", "cid", "secret", undefined, httpClient);
    expect(resp.access_token).toBe("at");
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(body?.get("code")).toBe("the-code");
  });

  it("throws with the response body when the exchange fails", async () => {
    const httpClient = (async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid_client",
    })) as unknown as typeof fetch;

    await expect(exchangeCode("bad", "cid", "secret", undefined, httpClient)).rejects.toThrow("invalid_client");
  });
});

describe("toFreeeToken", () => {
  it("turns expires_in into an absolute expiry", () => {
    const token = toFreeeToken(
      { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      123,
      1_700_000_000_000,
    );
    expect(token).toEqual({
      access_token: "at",
      refresh_token: "rt",
      expires_at: 1_700_003_600,
      company_id: 123,
    });
  });
});
