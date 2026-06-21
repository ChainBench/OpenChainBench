/**
 * Live native-token prices for the /chains/[slug] page. Returns the
 * spot price + market cap for the chain's native, fetched directly from
 * Mobula on every Nth call.
 *
 * The client polls this endpoint every 2 s. Server-side cache (1.5 s
 * via `unstable_cache`) absorbs the multiplier across concurrent
 * visitors: 1000 users on the same chain page = 1 upstream call per 1.5 s
 * total, not 1000.
 *
 * Mobula key is server-side only — never sent to the browser. Vercel
 * env var: MOBULA_API_KEY.
 */

import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { CHAIN_BY_SLUG } from "@/lib/chains";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LiveBody = {
  symbol: string | null;
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
  ts: number;
};

// Cache the upstream Mobula response per symbol for 1.5 s. The client
// polls every 2 s, so worst case the user sees a value at most ~3.5 s
// stale — well below the perceptual threshold for "live". Keyed on
// `symbol` only because the value is the same for every chain that
// shares a native (ETH for all L2s, etc).
const fetchPrice = unstable_cache(
  async (symbol: string): Promise<Omit<LiveBody, "ts">> => {
    const key = process.env.MOBULA_API_KEY?.trim();
    if (!key) {
      return { symbol, price: null, marketCap: null, volume24h: null };
    }
    try {
      const res = await fetch(
        `https://api.mobula.io/api/1/market/data?symbol=${encodeURIComponent(symbol)}`,
        {
          headers: {
            Authorization: key,
            "user-agent": "OCB-site/1.0",
            accept: "application/json",
          },
          signal: AbortSignal.timeout(4000),
          cache: "no-store",
        },
      );
      if (!res.ok) {
        return { symbol, price: null, marketCap: null, volume24h: null };
      }
      const json = (await res.json()) as {
        data?: { price?: number; market_cap?: number; volume?: number };
      };
      const d = json.data ?? {};
      return {
        symbol,
        price: d.price ?? null,
        marketCap: d.market_cap ?? null,
        volume24h: d.volume ?? null,
      };
    } catch {
      return { symbol, price: null, marketCap: null, volume24h: null };
    }
  },
  ["chain-kpis-live-v1"],
  { revalidate: 1.5, tags: ["chain-kpis-live"] },
);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const r = rateLimit(clientKey(req, "chain-kpis-live"), 120, 60, req);
  if (!r.ok) return tooManyRequests(r.retryAfterSec);

  const { slug } = await params;
  const chain = CHAIN_BY_SLUG.get(slug);
  if (!chain || !chain.nativeSymbol) {
    return NextResponse.json(
      { error: "not_a_tracked_chain" },
      { status: 404 },
    );
  }

  const data = await fetchPrice(chain.nativeSymbol);
  const body: LiveBody = { ...data, ts: Math.floor(Date.now() / 1000) };

  return NextResponse.json(body, {
    headers: {
      // CDN-level caching mirrors the server-side cache: 1.5 s fresh, 4 s
      // stale-while-revalidate so a few late requesters absorb gracefully.
      "cache-control": "public, s-maxage=1, stale-while-revalidate=3",
    },
  });
}
