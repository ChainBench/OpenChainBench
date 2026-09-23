/**
 * Every query that reaches `prom.scalar()` must identify exactly one
 * series. When it identifies several, scalar() returns an arbitrary one
 * — Prometheus contracts no ordering for instant vectors — and the board
 * publishes it as though it were the answer.
 *
 * That is not hypothetical. On 2026-09-23 this sweep found 156 such
 * queries across nine live benches, including a `success` gate taken
 * from 1 of 347 validators, and a p99 chosen from four chains whose
 * values spanned 0.01 to 85.3 gwei. Bench 277 lost its two largest
 * venues to the same mechanism: the gate resolved to the first of three
 * series, which happened to be 0.
 *
 * `pnpm validate` cannot catch this — it never queries Prometheus, and
 * whether a selector is fully constraining depends on the label set the
 * harness actually emits. So this is its own command, run against a
 * reachable Prom:
 *
 *   PROMETHEUS_URL=http://172.18.0.14:9090 pnpm tsx scripts/check-scalar-cardinality.ts
 *   ... --json          machine-readable, for the audit skill
 *   ... --bench <slug>  one bench
 *
 * Exit 1 when any query returns more than one series, so it can gate a
 * deploy once the nine known specs are repaired.
 *
 * The aggregate_filters / tier injection below must mirror
 * `applyDimensionsToSpec` in src/lib/materialize/load.ts. Without it the
 * sweep over-reports: perp-fees pins chain=ETH, so its raw spec query
 * looks multi-series while the query that actually runs is not.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { injectLabels } from "@/lib/materialize/load";

/** Every field load.ts hands to prom.scalar(). Keep in step with it. */
const SCALAR_KEYS = [
  "p50",
  "p90",
  "p99",
  "mean",
  "success",
  "sample_size",
  "slot_p50",
  "slot_p99",
  "live_activity",
  "ranked",
] as const;

type Job = {
  bench: string;
  provider: string;
  key: string;
  query: string;
  pin: string;
};

type Finding = Job & { series: number; varying: string[] };

function collect(benchFilter: string | null): Job[] {
  const dir = join(process.cwd(), "benchmarks");
  const jobs: Job[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const slug = f.replace(/\.yml$/, "");
    if (benchFilter && slug !== benchFilter) continue;
    let d: Record<string, unknown>;
    try {
      d = yaml.load(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    const status = d.status as string | undefined;
    if (status && status !== "live") continue;

    // What load.ts runs for the headline view: the spec's aggregate pin,
    // plus the pinned or first-declared tier on a tiered bench.
    const agg = (d.aggregate_filters ?? {}) as Record<string, string>;
    const labels: Record<string, string> = { ...agg };
    const tiers = ((d.dimensions as Record<string, { value: string }[]> | undefined)?.tier) ?? [];
    if (tiers.length > 0 && !labels.tier) labels.tier = agg.tier ?? tiers[0].value;
    const pin = Object.keys(labels).length ? JSON.stringify(labels) : "";

    for (const p of (d.providers as Record<string, unknown>[] | undefined) ?? []) {
      const q = (p?.queries ?? {}) as Record<string, string>;
      for (const key of SCALAR_KEYS) {
        const raw = q[key];
        if (typeof raw !== "string" || !raw.trim()) continue;
        jobs.push({
          bench: slug,
          provider: (p.slug as string) ?? "?",
          key,
          query: pin ? injectLabels(raw.trim(), labels) : raw.trim(),
          pin,
        });
      }
    }
  }
  return jobs;
}

async function seriesCount(
  base: string,
  query: string,
): Promise<{ n: number; varying: string[] }> {
  const url = `${base.replace(/\/+$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: { resultType: string; result: { metric: Record<string, string> }[] };
  };
  if (body.data.resultType === "scalar") return { n: 1, varying: [] };
  if (body.data.resultType !== "vector") return { n: 0, varying: [] };
  const r = body.data.result;
  if (r.length <= 1) return { n: r.length, varying: [] };
  const keys = new Set<string>();
  for (const s of r) for (const k of Object.keys(s.metric)) keys.add(k);
  const varying = [...keys]
    .filter((k) => new Set(r.map((s) => s.metric[k] ?? "")).size > 1)
    .sort();
  return { n: r.length, varying };
}

/** Bounded concurrency: Prom is local to the worker but this is still
 *  ~9,000 instant queries, and a burst of them is the one way this check
 *  could disturb what it is measuring. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const bi = args.indexOf("--bench");
  const benchFilter = bi >= 0 ? args[bi + 1] ?? null : null;

  const base = process.env.PROMETHEUS_URL?.trim();
  if (!base) {
    console.error("PROMETHEUS_URL is not set; this check needs a reachable Prometheus.");
    process.exit(2);
  }

  const jobs = collect(benchFilter);
  const findings: Finding[] = [];
  let one = 0;
  let empty = 0;
  let errored = 0;

  const results = await mapLimit(jobs, 12, async (j) => {
    try {
      return { j, ...(await seriesCount(base, j.query)) };
    } catch {
      return { j, n: -1, varying: [] as string[] };
    }
  });

  for (const { j, n, varying } of results) {
    if (n === -1) errored++;
    else if (n === 0) empty++;
    else if (n === 1) one++;
    else findings.push({ ...j, series: n, varying });
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { total: jobs.length, one, empty, errored, multi: findings.length, findings },
        null,
        2,
      ),
    );
  } else {
    console.log(`scalar queries checked : ${jobs.length}`);
    console.log(`  exactly one series   : ${one}`);
    console.log(`  empty                : ${empty}`);
    console.log(`  query errors         : ${errored}`);
    console.log(`  MULTI-SERIES         : ${findings.length}`);
    if (findings.length > 0) {
      const byBench = new Map<string, Finding[]>();
      for (const f of findings) {
        const list = byBench.get(f.bench) ?? [];
        list.push(f);
        byBench.set(f.bench, list);
      }
      console.log(`\n${byBench.size} bench(es) affected:\n`);
      for (const [bench, list] of [...byBench].sort((a, b) => b[1].length - a[1].length)) {
        const worst = list.reduce((a, b) => (b.series > a.series ? b : a));
        console.log(
          `  ${bench.padEnd(34)} ${String(list.length).padStart(3)} queries` +
            `   worst ${worst.series} series (${worst.provider}/${worst.key}` +
            `${worst.varying.length ? `, varying: ${worst.varying.join(", ")}` : ""})`,
        );
      }
      console.log(
        "\nEach of these publishes an arbitrary series as the provider's value.",
      );
      console.log(
        "Fix by aggregating explicitly in the spec query, or by pinning the",
      );
      console.log("dimension through aggregate_filters, as perp-fees does with chain=ETH.");
    }
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
