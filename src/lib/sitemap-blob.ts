import { unstable_cache } from "next/cache";

const DEFAULT_URL =
  process.env.VERCEL_ENV
    ? "https://openchainbench.com/api/sitemap-data"
    : "https://kv.openchainbench.com/aggregate/sitemap.json";

const FETCH_TIMEOUT_MS = 15_000;

export type SitemapBench = {
  slug: string;
  lastRunAt: string | null;
  category: string;
  perChainSlugs: string[];
  chainDimensions: string[];
};

export type SitemapBlob = {
  v: number;
  builtAt: number;
  benches: SitemapBench[];
  providerSlugs: string[];
  hlBuilderSlugs: string[];
};

function isBlob(x: unknown): x is SitemapBlob {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.builtAt === "number" &&
    Array.isArray(o.benches) &&
    Array.isArray(o.providerSlugs) &&
    Array.isArray(o.hlBuilderSlugs)
  );
}

async function fetchSitemapBlob(): Promise<SitemapBlob | null> {
  const url = process.env.SITEMAP_BLOB_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
      headers: { "Accept-Encoding": "gzip, br" },
    });
    if (!res.ok) throw new Error(`[sitemap-blob] fetch ${url} → ${res.status}`);
    const raw = await res.json();
    if (!isBlob(raw) || raw.v !== 1) {
      console.warn("[sitemap-blob] schema mismatch");
      return null;
    }
    if (raw.benches.length < 5) {
      console.warn(`[sitemap-blob] suspiciously small: ${raw.benches.length} benches`);
      return null;
    }
    return raw;
  } catch (err) {
    console.warn(`[sitemap-blob] fetch failed: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

export const loadSitemapBlob = unstable_cache(
  fetchSitemapBlob,
  ["sitemap-blob-v1"],
  { revalidate: 60, tags: ["bench-aggregate", "benchmarks"] },
);
