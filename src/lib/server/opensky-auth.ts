import { readServerSecret } from './env-config';

const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let oauthToken: string | null = null;
let oauthExpiry = 0;
let tokenInFlight: Promise<Record<string, string>> | null = null;

/**
 * Shared OpenSky OAuth2 client-credentials helper with token caching and request coalescing.
 */
export async function getOpenSkyAuthHeaders(): Promise<Record<string, string>> {
  const clientId = await readServerSecret('OPENSKY_CLIENT_ID');
  const clientSecret = await readServerSecret('OPENSKY_CLIENT_SECRET');
  if (!clientId || !clientSecret) return {};

  const now = Date.now();
  if (oauthToken && now < oauthExpiry - 30_000) {
    return { Authorization: `Bearer ${oauthToken}` };
  }

  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async (): Promise<Record<string, string>> => {
    try {
      const resp = await fetch(OPENSKY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { access_token?: string; expires_in?: number };
        if (json.access_token) {
          oauthToken = json.access_token;
          oauthExpiry = Date.now() + (Number(json.expires_in) || 1800) * 1000;
          return { Authorization: `Bearer ${oauthToken}` };
        }
      }
    } catch {
      // Fall back cleanly to anonymous / regional endpoints
    } finally {
      tokenInFlight = null;
    }
    return {};
  })();

  return (await tokenInFlight) ?? {};
}
