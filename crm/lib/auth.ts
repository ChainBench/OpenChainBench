/**
 * One shared password, one cookie. The cookie value is an HMAC of a fixed
 * label under the password, so it is stable across restarts, carries no
 * secret, and rotating CRM_PASSWORD invalidates every session at once.
 * Web Crypto only: this runs in proxy.ts as well as in route handlers.
 */
export const COOKIE = "ocb_crm";
const LABEL = "ocb-crm-session-v1";

function password(): string {
  return process.env.CRM_PASSWORD ?? "";
}

export function authConfigured(): boolean {
  return password().length >= 8;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sessionToken(): Promise<string> {
  return hmacHex(password(), LABEL);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  if (!authConfigured() || !cookieValue) return false;
  return timingSafeEqual(cookieValue, await sessionToken());
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  if (!authConfigured() || candidate.length === 0) return false;
  // Compare HMACs rather than the strings: equal length, constant time.
  return timingSafeEqual(await hmacHex(candidate, LABEL), await sessionToken());
}

/** 303 to a same-origin path. The origin is rebuilt from the forwarded
 *  headers: the standalone server binds 0.0.0.0 and Next absolutises a
 *  relative Location with that host, which behind Railway's proxy sends
 *  the browser to http://0.0.0.0. */
export function seeOther(request: Request, pathWithQuery: string): Response {
  const safe = pathWithQuery.startsWith("/") && !pathWithQuery.startsWith("//") ? pathWithQuery : "/";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
  const proto = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return new Response(null, { status: 303, headers: { Location: `${proto}://${host.split(",")[0].trim()}${safe}` } });
}
