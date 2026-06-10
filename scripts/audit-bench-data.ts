/**
 * One-shot data audit: executes every scalar query of every bench spec
 * against the live Prometheus gateway and reports anomalies (empty
 * results, zero/identical values, implausible success rates, dimension
 * values absent from the metric labels). Read-only; safe to run anytime.
 *
 *   bun scripts/audit-bench-data.ts [--prom https://...]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const PROM =
  process.argv.includes("--prom")
    ? process.argv[process.argv.indexOf("--prom") + 1]
    : "https://prom-gateway-production.up.railway.app";

type Spec = {
  slug: string;
  status?: string;
  unit?: string;
  prometheus?: { url?: string };
  dimensions?: Record<string, { value: string; label: string }[]>;
  rank_matrix_query?: string;
  providers: {
    slug: string;
    queries?: Record<string, unknown>;
  }[];
};

let active = 0;
const waiters: (() => void)[] = [];
async function slot() {
  if (active < 8) {
    active++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
}
function release() {
  const n = waiters.shift();
  if (n) n();
  else active--;
}

async function q(promql: string, base = PROM): Promise<number | null | "ERROR"> {
  await slot();
  try {
    const url = new URL("/api/v1/query", base);
    url.searchParams.set("query", promql);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as {
      status: string;
      data?: { resultType: string; result: unknown[] };
    };
    if (j.status !== "success") return "ERROR";
    const r = j.data;
    if (!r) return "ERROR";
    if (r.resultType === "scalar") {
      const v = Number((r.result as [number, string])[1]);
      return Number.isFinite(v) ? v : null;
    }
    if (r.resultType === "vector" && r.result.length > 0) {
      const v = Number(
        (r.result[0] as { value: [number, string] }).value[1],
      );
      return Number.isFinite(v) ? v : null;
    }
    return null;
  } catch {
    return "ERROR";
  } finally {
    release();
  }
}

async function labelValues(
  metric: string,
  label: string,
  base = PROM,
): Promise<Set<string>> {
  await slot();
  try {
    const url = new URL("/api/v1/query", base);
    url.searchParams.set("query", `count by (${label}) (${metric})`);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as {
      data?: { result: { metric: Record<string, string> }[] };
    };
    return new Set(
      (j.data?.result ?? []).map((s) => s.metric[label]).filter(Boolean),
    );
  } catch {
    return new Set();
  } finally {
    release();
  }
}

function extractMetric(promql: string): string | null {
  const m = promql.match(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/);
  return m ? m[1] : null;
}

const dir = path.join(process.cwd(), "benchmarks");
const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yml"));
const report: string[] = [];

for (const file of files.sort()) {
  const spec = yaml.load(await fs.readFile(path.join(dir, file), "utf8")) as Spec;
  if (!spec?.providers) continue;
  // Respect per-spec Prometheus (federation: some benches declare their own).
  const base = spec.prometheus?.url ?? PROM;
  const issues: string[] = [];
  const p50s = new Map<string, number>();

  await Promise.all(
    spec.providers.map(async (p) => {
      const qs = (p.queries ?? {}) as Record<string, string>;
      const checks: [string, string][] = [];
      for (const k of ["p50", "p90", "p99", "success", "sample_size"]) {
        if (typeof qs[k] === "string") checks.push([k, qs[k]]);
      }
      const vals = await Promise.all(checks.map(([, query]) => q(query, base)));
      checks.forEach(([k], i) => {
        const v = vals[i];
        if (v === "ERROR") issues.push(`${p.slug}.${k}: QUERY ERROR`);
        else if (v === null) issues.push(`${p.slug}.${k}: EMPTY`);
        else {
          if (k === "p50") {
            if (v <= 0) issues.push(`${p.slug}.p50: ${v} (<=0)`);
            p50s.set(p.slug, v);
          }
          if (k === "success") {
            const pct = v > 1 ? v : v * 100;
            if (pct <= 0) issues.push(`${p.slug}.success: 0%`);
            if (pct > 100.5) issues.push(`${p.slug}.success: ${pct.toFixed(1)}% (>100)`);
          }
          if (k === "sample_size" && v === 0) issues.push(`${p.slug}.sample_size: 0`);
        }
      });
    }),
  );

  // Identical p50 across 3+ providers = suspicious copy-paste / constant.
  const byVal = new Map<number, string[]>();
  for (const [s, v] of p50s) {
    const key = Math.round(v * 1000) / 1000;
    byVal.set(key, [...(byVal.get(key) ?? []), s]);
  }
  for (const [v, slugs] of byVal) {
    if (slugs.length >= 3) issues.push(`identical p50=${v} across: ${slugs.join(",")}`);
  }

  // Dimension values present in the actual metric labels?
  const firstQuery = (spec.providers[0]?.queries as Record<string, string>)?.p50;
  const metric = firstQuery ? extractMetric(firstQuery) : null;
  if (metric && spec.dimensions) {
    for (const dim of ["chain", "region"] as const) {
      const declared = (spec.dimensions[dim] ?? [])
        .map((d) => d.value)
        .filter((v) => v !== "all");
      if (declared.length === 0) continue;
      const present = await labelValues(metric, dim, base);
      if (present.size === 0) continue; // metric may not carry the label at this granularity
      const missing = declared.filter((v) => !present.has(v));
      if (missing.length > 0)
        issues.push(`dimension ${dim}: declared but absent from ${metric}: ${missing.join(",")}`);
    }
  }

  if (spec.rank_matrix_query) {
    const v = await q(`count(${spec.rank_matrix_query})`, base);
    if (v === null || v === "ERROR" || v === 0)
      issues.push(`rank_matrix_query: ${v === 0 ? "0 series" : String(v)}`);
  }

  const head = `${spec.slug}${spec.status === "draft" ? " [draft]" : ""}`;
  if (issues.length === 0) report.push(`OK   ${head} (${p50s.size}/${spec.providers.length} providers live)`);
  else report.push(`WARN ${head}\n       ${issues.join("\n       ")}`);
}

console.log(report.join("\n"));
