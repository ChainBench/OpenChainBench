import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { redisPipeline, storeConfigured } from "@/lib/materialize/store";
import { geohashCenter, median, monthKeys, parseLatEntry } from "@/lib/speedtest/geo";
import { RPC_DIRECTORY } from "@/lib/speedtest/rpc-directory";

export const runtime = "nodejs";

/**
 * Aggregated read side of the crowdsourced latency map. Returns, per
 * geohash-4 cell, the median contributed p50 for every provider seen
 * there, plus the winner. Everything is CC-BY-4.0 like the rest of the
 * public data.
 */

const KNOWN_CHAINS = new Set(RPC_DIRECTORY.map((c) => c.slug));

type CellOut = {
  gh: string;
  lat: number;
  lon: number;
  city: string;
  country: string;
  providers: { slug: string; p50: number; samples: number; lastTs: number | null }[];
  best: string;
};

async function buildMap(chain: string): Promise<{ cells: CellOut[]; total: number }> {
  const [cur, prev] = monthKeys(new Date());
  const [curPairs, prevPairs, totalRaw] = (await redisPipeline([
    ["SMEMBERS", `stm:idx:${cur}:${chain}`],
    ["SMEMBERS", `stm:idx:${prev}:${chain}`],
    ["GET", "stm:total"],
  ])) as [string[] | null, string[] | null, string | null];
  const pairs = Array.from(new Set([...(curPairs ?? []), ...(prevPairs ?? [])]));
  if (pairs.length === 0) return { cells: [], total: Number(totalRaw ?? 0) };

  // Cap the read fan-out defensively; ~500 (cell, provider) pairs is far
  // beyond current reality and still one pipeline round trip.
  const capped = pairs.slice(0, 500);
  const readCmds: (string | number)[][] = [];
  for (const pair of capped) {
    const [gh, slug] = [pair.slice(0, 4), pair.slice(5)];
    readCmds.push(["LRANGE", `stm:lat:${cur}:${gh}:${chain}:${slug}`, 0, -1]);
    readCmds.push(["LRANGE", `stm:lat:${prev}:${gh}:${chain}:${slug}`, 0, -1]);
  }
  const ghs = Array.from(new Set(capped.map((p) => p.slice(0, 4))));
  for (const gh of ghs) readCmds.push(["HGETALL", `stm:meta:${gh}`]);
  const results = await redisPipeline(readCmds);

  const metaByGh = new Map<string, Record<string, string>>();
  for (let i = 0; i < ghs.length; i++) {
    const flat = results[capped.length * 2 + i] as string[] | Record<string, string> | null;
    // REST returns HGETALL as a flat array; TCP client may return a map.
    let obj: Record<string, string> = {};
    if (Array.isArray(flat)) {
      for (let j = 0; j < flat.length; j += 2) obj[flat[j]] = flat[j + 1];
    } else if (flat && typeof flat === "object") {
      obj = flat as Record<string, string>;
    }
    metaByGh.set(ghs[i], obj);
  }

  const byCell = new Map<string, CellOut>();
  for (let i = 0; i < capped.length; i++) {
    const pair = capped[i];
    const gh = pair.slice(0, 4);
    const slug = pair.slice(5);
    const curList = (results[i * 2] as string[] | null) ?? [];
    const prevList = (results[i * 2 + 1] as string[] | null) ?? [];
    const entries = [...curList, ...prevList]
      .map((raw) => parseLatEntry(String(raw)))
      .filter((e): e is { ts: number | null; p50: number } => e !== null);
    const values = entries.map((e) => e.p50);
    if (values.length === 0) continue;
    let cell = byCell.get(gh);
    if (!cell) {
      const meta = metaByGh.get(gh) ?? {};
      const center = geohashCenter(gh);
      cell = {
        gh,
        lat: Number(meta.lat ?? center.lat),
        lon: Number(meta.lon ?? center.lon),
        city: meta.city ?? "Unknown",
        country: meta.country ?? "??",
        providers: [],
        best: "",
      };
      byCell.set(gh, cell);
    }
    const tss = entries.map((e) => e.ts).filter((t): t is number => t !== null);
    cell.providers.push({
      slug,
      p50: Math.round(median(values) * 10) / 10,
      samples: values.length,
      lastTs: tss.length > 0 ? Math.max(...tss) : null,
    });
  }
  const cells = Array.from(byCell.values());
  for (const c of cells) {
    c.providers.sort((a, b) => a.p50 - b.p50);
    c.best = c.providers[0]?.slug ?? "";
  }
  cells.sort((a, b) => b.providers.reduce((s, p) => s + p.samples, 0) - a.providers.reduce((s, p) => s + p.samples, 0));
  return { cells, total: Number(totalRaw ?? 0) };
}

const cachedMap = unstable_cache(
  async (chain: string) => buildMap(chain),
  ["speedtest-map-v1"],
  { revalidate: 300 },
);

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") ?? "ethereum";
  if (!KNOWN_CHAINS.has(chain)) {
    return NextResponse.json({ error: "unknown_chain" }, { status: 400 });
  }
  if (!storeConfigured()) {
    return NextResponse.json({ cells: [], total: 0, license: "CC-BY-4.0" });
  }
  try {
    const data = await cachedMap(chain);
    return NextResponse.json(
      { chain, ...data, license: "CC-BY-4.0" },
      {
        headers: {
          "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
          "access-control-allow-origin": "*",
        },
      },
    );
  } catch {
    return NextResponse.json({ cells: [], total: 0, license: "CC-BY-4.0" });
  }
}
