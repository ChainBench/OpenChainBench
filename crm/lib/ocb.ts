/**
 * The non-PostHog sections: what the site itself publishes. All public
 * endpoints except Dune, whose key is optional.
 *
 *  - Bench health: the index blob the materialize worker publishes, one
 *    row per live bench with its last measurement. Same thresholds as the
 *    site: stale after 24 h (the page says so), expired after 168 h (the page
 *    is noindex and leaves the sitemap).
 *  - Harness health: Prometheus scrape targets, up or down.
 *  - Dune: credits left on the plan and when the period ends.
 */
import { z } from "zod";

// index.json lists every bench the worker knows with its status; the
// sitemap blob would not do, the worker drops expired chain RPC benches and
// thin ones from it before publishing, which is what this page must show.
const INDEX_BLOB_URL = process.env.INDEX_BLOB_URL ?? "https://kv.openchainbench.com/aggregate/index.json";
const SITEMAP_BLOB_URL = process.env.SITEMAP_BLOB_URL ?? "https://kv.openchainbench.com/aggregate/sitemap.json";
const PROM_URL = (process.env.PROM_URL ?? "https://prom.openchainbench.com").replace(/\/$/, "");
const STALE_AFTER_HOURS = 24;
const EXPIRED_AFTER_HOURS = 168;

const indexSchema = z.object({
  builtAt: z.union([z.string(), z.number()]).optional(),
  benches: z.array(
    z.object({ slug: z.string(), status: z.string().optional(), lastRunAt: z.string().nullable().optional(), category: z.string().optional() }),
  ),
});
const sitemapSchema = z.object({ providerSlugs: z.array(z.string()).optional() });

export type BenchRow = { slug: string; category: string; lastRunAt: string | null; ageHours: number | null; state: "fresh" | "stale" | "expired" | "unknown" };
export type BenchHealth = {
  builtAt: string | null;
  total: number;
  fresh: number;
  stale: number;
  expired: number;
  providers: number;
  byCategory: { category: string; total: number; stale: number; expired: number }[];
  attention: BenchRow[];
};

export async function loadBenchHealth(now = Date.now()): Promise<BenchHealth> {
  const [res, sm] = await Promise.all([
    fetch(INDEX_BLOB_URL, { signal: AbortSignal.timeout(20_000), cache: "no-store" }),
    fetch(SITEMAP_BLOB_URL, { signal: AbortSignal.timeout(20_000), cache: "no-store" }).catch(() => null),
  ]);
  if (!res.ok) throw new Error(`index blob ${res.status}`);
  const blob = indexSchema.parse(await res.json());
  const providers = sm && sm.ok ? (sitemapSchema.safeParse(await sm.json()).data?.providerSlugs?.length ?? 0) : 0;
  const rows: BenchRow[] = blob.benches.filter((b) => b.status === "live").map((b) => {
    const t = Date.parse(b.lastRunAt ?? "");
    const ageHours = Number.isFinite(t) ? (now - t) / 3_600_000 : null;
    const state = ageHours == null ? "unknown" : ageHours > EXPIRED_AFTER_HOURS ? "expired" : ageHours > STALE_AFTER_HOURS ? "stale" : "fresh";
    return { slug: b.slug, category: b.category ?? "Uncategorised", lastRunAt: b.lastRunAt ?? null, ageHours, state };
  });
  const cats = new Map<string, { total: number; stale: number; expired: number }>();
  for (const r of rows) {
    const c = cats.get(r.category) ?? { total: 0, stale: 0, expired: 0 };
    c.total += 1;
    if (r.state === "stale") c.stale += 1;
    if (r.state === "expired" || r.state === "unknown") c.expired += 1;
    cats.set(r.category, c);
  }
  // builtAt is epoch milliseconds in the blob; normalised to ISO here.
  const builtAt =
    typeof blob.builtAt === "number" ? new Date(blob.builtAt).toISOString() : typeof blob.builtAt === "string" ? blob.builtAt : null;
  return {
    builtAt,
    total: rows.length,
    fresh: rows.filter((r) => r.state === "fresh").length,
    stale: rows.filter((r) => r.state === "stale").length,
    expired: rows.filter((r) => r.state === "expired" || r.state === "unknown").length,
    providers,
    byCategory: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total),
    attention: rows.filter((r) => r.state !== "fresh").sort((a, b) => (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity)),
  };
}

const targetsSchema = z.object({
  data: z.object({
    activeTargets: z.array(
      z.object({
        labels: z.record(z.string(), z.string()),
        health: z.string(),
        lastScrape: z.string().optional(),
        lastError: z.string().optional(),
        scrapeUrl: z.string().optional(),
      }),
    ),
  }),
});

export type TargetRow = { job: string; instance: string; health: string; lastScrape: string | null; lastError: string };
export type HarnessHealth = { total: number; up: number; down: TargetRow[] };

export async function loadHarnessHealth(): Promise<HarnessHealth> {
  const res = await fetch(`${PROM_URL}/api/v1/targets?state=active`, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!res.ok) throw new Error(`prometheus targets ${res.status}`);
  const parsed = targetsSchema.parse(await res.json());
  const rows: TargetRow[] = parsed.data.activeTargets.map((t) => ({
    job: t.labels.job ?? "?",
    // The instance label names hosts and ports; keyed RPC URLs never reach
    // the labels (the harness reads them from env), so this is safe to show.
    instance: t.labels.instance ?? "",
    health: t.health,
    lastScrape: t.lastScrape ?? null,
    lastError: t.lastError ?? "",
  }));
  return { total: rows.length, up: rows.filter((r) => r.health === "up").length, down: rows.filter((r) => r.health !== "up") };
}

export type DuneUsage = { creditsUsed: number; creditsIncluded: number; periodStart: string | null; periodEnd: string | null };

const duneSchema = z.object({
  billing_periods: z.array(z.object({ start_date: z.string(), end_date: z.string(), credits_used: z.number(), credits_included: z.number() })),
});

/** Only when DUNE_API_KEY is set; the key never leaves the server. */
export async function loadDuneUsage(): Promise<DuneUsage | null> {
  const key = process.env.DUNE_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.dune.com/api/v1/usage", {
    method: "POST",
    headers: { "X-Dune-API-Key": key, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`dune usage ${res.status}`);
  const parsed = duneSchema.parse(await res.json());
  // The current period is the one that ends last.
  const period = [...parsed.billing_periods].sort((x, y) => y.end_date.localeCompare(x.end_date))[0];
  if (!period) return { creditsUsed: 0, creditsIncluded: 0, periodStart: null, periodEnd: null };
  return { creditsUsed: period.credits_used, creditsIncluded: period.credits_included, periodStart: period.start_date, periodEnd: period.end_date };
}
