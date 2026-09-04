import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { redisPipeline, storeConfigured } from "@/lib/materialize/store";
import { median, monthKeys, parseLatEntry } from "@/lib/speedtest/geo";
import { RPC_DIRECTORY } from "@/lib/speedtest/rpc-directory";

export const runtime = "nodejs";

/**
 * Detail view for one map cell: the full retained contribution history
 * (last 24 readings per provider over the rolling two-month window),
 * with timestamps, powering the click-through panel on /rpc-map.
 */

const KNOWN_CHAINS = new Set(RPC_DIRECTORY.map((c) => c.slug));
const GH_RE = /^[0-9b-hj-km-np-z]{4}$/;

async function buildCell(chain: string, gh: string) {
  const [cur, prev] = monthKeys(new Date());
  const [curPairs, prevPairs, metaFlat] = (await redisPipeline([
    ["SMEMBERS", `stm:idx:${cur}:${chain}`],
    ["SMEMBERS", `stm:idx:${prev}:${chain}`],
    ["HGETALL", `stm:meta:${gh}`],
  ])) as [string[] | null, string[] | null, string[] | Record<string, string> | null];

  const slugs = Array.from(
    new Set(
      [...(curPairs ?? []), ...(prevPairs ?? [])]
        .filter((p) => p.startsWith(`${gh}:`))
        .map((p) => p.slice(5)),
    ),
  );
  let meta: Record<string, string> = {};
  if (Array.isArray(metaFlat)) {
    for (let j = 0; j < metaFlat.length; j += 2) meta[metaFlat[j]] = metaFlat[j + 1];
  } else if (metaFlat && typeof metaFlat === "object") {
    meta = metaFlat as Record<string, string>;
  }
  if (slugs.length === 0) return { gh, city: meta.city ?? "Unknown", country: meta.country ?? "??", providers: [] };

  const readCmds: (string | number)[][] = [];
  for (const slug of slugs) {
    readCmds.push(["LRANGE", `stm:lat:${cur}:${gh}:${chain}:${slug}`, 0, -1]);
    readCmds.push(["LRANGE", `stm:lat:${prev}:${gh}:${chain}:${slug}`, 0, -1]);
  }
  const results = await redisPipeline(readCmds);

  const providers = slugs
    .map((slug, i) => {
      const entries = [
        ...((results[i * 2] as string[] | null) ?? []),
        ...((results[i * 2 + 1] as string[] | null) ?? []),
      ]
        .map((raw) => parseLatEntry(String(raw)))
        .filter((e): e is { ts: number | null; p50: number } => e !== null)
        // LPUSH order is newest first; keep it that way for the panel.
        .slice(0, 24);
      if (entries.length === 0) return null;
      const values = entries.map((e) => e.p50);
      const tss = entries.map((e) => e.ts).filter((t): t is number => t !== null);
      return {
        slug,
        p50: Math.round(median(values) * 10) / 10,
        samples: entries.length,
        lastTs: tss.length > 0 ? Math.max(...tss) : null,
        history: entries.map((e) => ({ ts: e.ts, p50: Math.round(e.p50 * 10) / 10 })),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => a.p50 - b.p50);

  return { gh, city: meta.city ?? "Unknown", country: meta.country ?? "??", providers };
}

const cachedCell = unstable_cache(
  async (chain: string, gh: string) => buildCell(chain, gh),
  ["speedtest-cell-v1"],
  { revalidate: 120 },
);

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") ?? "";
  const gh = req.nextUrl.searchParams.get("gh") ?? "";
  if (!KNOWN_CHAINS.has(chain) || !GH_RE.test(gh)) {
    return NextResponse.json({ error: "bad_params" }, { status: 400 });
  }
  if (!storeConfigured()) {
    return NextResponse.json({ gh, providers: [] });
  }
  try {
    const data = await cachedCell(chain, gh);
    return NextResponse.json(data, {
      headers: {
        "cache-control": "public, s-maxage=120, stale-while-revalidate=600",
        "access-control-allow-origin": "*",
      },
    });
  } catch {
    return NextResponse.json({ gh, providers: [] });
  }
}
