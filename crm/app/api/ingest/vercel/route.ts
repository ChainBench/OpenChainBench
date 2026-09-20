import { drainConfigured, ingestEntries, parseBody, verifySignature } from "@/lib/vercel-logs";

// Public route (proxy.ts lets it through): authenticated by Vercel's HMAC
// signature over the raw body, never by the session cookie. The
// verification handshake answers with the token Vercel expects.
export const dynamic = "force-dynamic";
const MAX_BODY = 8 * 1024 * 1024;

function verifyHeaders(): HeadersInit {
  const v = process.env.VERCEL_LOG_DRAIN_VERIFY;
  return v ? { "x-vercel-verify": v } : {};
}

export async function GET() {
  return new Response("ok", { status: 200, headers: verifyHeaders() });
}

export async function HEAD() {
  return new Response(null, { status: 200, headers: verifyHeaders() });
}

export async function POST(request: Request) {
  if (!drainConfigured()) return new Response("drain not configured", { status: 503, headers: verifyHeaders() });
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY) return new Response("too large", { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });
  if (!verifySignature(raw, request.headers.get("x-vercel-signature"))) {
    return new Response("bad signature", { status: 401, headers: verifyHeaders() });
  }
  const entries = parseBody(raw);
  const folded = ingestEntries(entries);
  return Response.json({ received: entries.length, folded }, { headers: verifyHeaders() });
}
