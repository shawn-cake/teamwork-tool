// Cloudflare Access JWT verification — defense-in-depth behind the Access edge gate.
//
// When CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set (wrangler.jsonc vars),
// every request must carry a valid `Cf-Access-Jwt-Assertion` header, which
// Access injects after SSO login. When they are unset (local dev, or Access
// not yet configured), verification is skipped: the edge-level Access policy
// is the primary gate — this check ensures the Worker rejects direct hits
// that bypass it (e.g. the workers.dev URL after a custom domain is added).
//
// Verifies: RS256 signature against the team's JWKS, audience tag, issuer,
// and the exp/nbf validity window.

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}

async function getJwks(teamDomain, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const { keys } = await res.json();
  jwksCache = { keys: keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

// Returns { ok: true, skipped?, email? } or { ok: false, reason }.
export async function verifyAccessJwt(request, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) return { ok: true, skipped: true };

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { ok: false, reason: 'missing Access token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header, payload;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    return { ok: false, reason: 'undecodable token' };
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return { ok: false, reason: 'audience mismatch' };
  if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: 'issuer mismatch' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) return { ok: false, reason: 'token expired' };
  if (typeof payload.nbf === 'number' && now < payload.nbf) return { ok: false, reason: 'token not yet valid' };

  let keys;
  try {
    keys = await getJwks(teamDomain);
  } catch (e) {
    return { ok: false, reason: `signing keys unavailable: ${e.message}` };
  }
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation — refetch once before rejecting.
    try { keys = await getJwks(teamDomain, true); } catch { /* keep stale keys */ }
    jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'unknown signing key' };
  }

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return { ok: false, reason: 'invalid signature' };
  } catch (e) {
    return { ok: false, reason: `verification error: ${e.message}` };
  }

  return { ok: true, email: payload.email ?? null };
}
