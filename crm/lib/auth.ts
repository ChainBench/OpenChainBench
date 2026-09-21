/**
 * One shared password, per-login sessions.
 *
 * The cookie is `nonce.expiry.signature`, signed with CRM_SESSION_SECRET (a
 * random value, not the password: a leaked cookie gives nothing to brute
 * force offline). A session is valid while its signature checks, its expiry
 * is ahead and its nonce is still listed on the volume (lib/sessions.ts), so
 * logout revokes it. Rotating either env logs everyone out. Web Crypto only:
 * this runs in proxy.ts as well as in route handlers.
 */
import { listSession, sessionListed, unlistSession } from "@/lib/sessions";

export const COOKIE = "ocb_crm";
export const SESSION_DAYS = 30;
// 12 for the password (a memorable one, behind the per-client and global
// login limits), 16 for the signing secret (random, never typed).
const MIN_PASSWORD_LEN = 12;
const MIN_SECRET_LEN = 16;

const password = () => process.env.CRM_PASSWORD ?? "";
const secret = () => process.env.CRM_SESSION_SECRET ?? "";

export function authConfigured(): boolean {
  return password().length >= MIN_PASSWORD_LEN && secret().length >= MIN_SECRET_LEN;
}

const enc = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  if (!authConfigured() || candidate.length === 0) return false;
  // Compare HMACs of the two strings under the session secret: equal
  // length whatever the input, constant time.
  return timingSafeEqual(await hmacHex(secret(), candidate), await hmacHex(secret(), password()));
}

export type ParsedSession = { nonce: string; expiresAt: number; sig: string };

export function parseSession(cookieValue: string | undefined): ParsedSession | null {
  const parts = (cookieValue ?? "").split(".");
  if (parts.length !== 3) return null;
  const [nonce, expRaw, sig] = parts;
  const expiresAt = Number.parseInt(expRaw, 10);
  if (!/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(expiresAt) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  return { nonce, expiresAt, sig };
}

const payload = (nonce: string, expiresAt: number) => `${nonce}.${expiresAt}`;

/** Signature and expiry only; the listing check is separate so tests can cover each. */
export async function sessionSigned(s: ParsedSession, now = Date.now()): Promise<boolean> {
  if (!authConfigured() || s.expiresAt <= now) return false;
  return timingSafeEqual(s.sig, await hmacHex(secret(), payload(s.nonce, s.expiresAt)));
}

export async function isValidSession(cookieValue: string | undefined, now = Date.now()): Promise<boolean> {
  const s = parseSession(cookieValue);
  if (!s) return false;
  if (!(await sessionSigned(s, now))) return false;
  return sessionListed(s.nonce, now);
}

export async function issueSession(now = Date.now()): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  const sig = await hmacHex(secret(), payload(nonce, expiresAt));
  await listSession(nonce, expiresAt, now);
  return `${payload(nonce, expiresAt)}.${sig}`;
}

export async function revokeSession(cookieValue: string | undefined): Promise<void> {
  const s = parseSession(cookieValue);
  if (s) await unlistSession(s.nonce);
}

/** Login attempts, in memory, on globalThis so every bundler layer shares
 *  the map. Two brakes: per client (10 per 15 minutes) and global (60 per
 *  15 minutes, whatever the keys), because the client key is only as good as
 *  the edge's forwarded header. Keys are evicted when their window is empty. */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS_GLOBAL = 60;
const MAX_KEYS = 1000;
type Attempts = { byKey: Map<string, number[]>; all: number[] };
const g = globalThis as unknown as { __ocbLoginAttempts?: Attempts };
const attempts: Attempts = (g.__ocbLoginAttempts ??= { byKey: new Map(), all: [] });

/** The hop the edge appended, i.e. the last X-Forwarded-For entry: the
 *  first entry is whatever the client wrote. No x-real-ip fallback, the
 *  platform is not known to set it. */
export function clientKey(request: Request): string {
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) ?? "unknown";
}

function sweep(now: number): void {
  attempts.all = attempts.all.filter((t) => now - t < WINDOW_MS);
  for (const [k, list] of attempts.byKey) {
    const recent = list.filter((t) => now - t < WINDOW_MS);
    if (recent.length === 0) attempts.byKey.delete(k);
    else attempts.byKey.set(k, recent);
  }
}

export function loginAllowed(key: string, now = Date.now()): boolean {
  sweep(now);
  if (attempts.all.length >= MAX_ATTEMPTS_GLOBAL) return false;
  if (attempts.byKey.size >= MAX_KEYS && !attempts.byKey.has(key)) return false;
  return (attempts.byKey.get(key) ?? []).length < MAX_ATTEMPTS;
}

export function recordLoginAttempt(key: string, now = Date.now()): void {
  attempts.all.push(now);
  attempts.byKey.set(key, [...(attempts.byKey.get(key) ?? []), now]);
}

/** Test seam. */
export function resetLoginAttempts(): void {
  attempts.byKey.clear();
  attempts.all = [];
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
