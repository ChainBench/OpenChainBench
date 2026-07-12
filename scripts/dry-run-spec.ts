#!/usr/bin/env tsx
/**
 * `pnpm spec:dry-run <slug>`. fetches a single benchmark from Prometheus
 * exactly the way the website does, and prints the resolved Benchmark
 * object as JSON. Useful when you're tweaking a YAML and want to confirm
 * the queries return what you expect before opening a PR.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SpecSchema } from "../src/lib/spec-schema";
import { Prometheus } from "../src/lib/prometheus";

const ROOT = path.resolve(__dirname, "..");
const SPECS_DIR = path.join(ROOT, "benchmarks");

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: pnpm spec:dry-run <slug>");
    process.exit(1);
  }

  const file = (await fs.readdir(SPECS_DIR)).find(
    (f) => f === `${slug}.yml` || f === `${slug}.yaml`
  );
  if (!file) {
    console.error(`No spec found for slug "${slug}" in benchmarks/`);
    process.exit(1);
  }

  const raw = await fs.readFile(path.join(SPECS_DIR, file), "utf8");
  const spec = SpecSchema.parse(yaml.load(raw));

  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) {
    console.error("No prometheus.url in spec and PROMETHEUS_URL env var unset.");
    process.exit(1);
  }

  const prom = new Prometheus(url);

  console.log(`\n=== Dry run · ${spec.slug} → ${url} ===\n`);

  // Quick scalar check per provider
  console.log("SCALARS (per provider):");
  for (const p of spec.providers) {
    const q = p.queries ?? {};
    const [p50, p90, p99, success, sampleSize] = await Promise.all([
      q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
      q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
      q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
      q.success ? prom.scalar(q.success) : Promise.resolve(null),
      q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
    ]);
    console.log(
      `  ${p.slug.padEnd(18)} ` +
        `p50=${fmt(p50)}  p90=${fmt(p90)}  p99=${fmt(p99)}  ` +
        `success=${success != null ? `${(success * 100).toFixed(2)}%` : "—"}  ` +
        `n=${sampleSize ?? "—"}`
    );
  }

  // Series check per provider. what TimeSeriesChart actually plots
  console.log("\nSERIES (per provider):");
  const win = parseDurationSec(spec.prometheus?.window ?? "24h") ?? 86_400;
  for (const p of spec.providers) {
    const q = p.queries ?? {};
    if (!q.series) {
      console.log(`  ${p.slug.padEnd(18)} no 'series' query in spec`);
      continue;
    }
    const s = await prom.series(q.series, win, 72);
    if (s == null) {
      console.log(
        `  ${p.slug.padEnd(18)} ✗ NULL. no data returned. Provider will be MISSING from time-series chart.`
      );
      // Probe the raw query to see what Prometheus says
      try {
        const raw = await prom.query(q.series);
        if (raw.resultType === "vector") {
          console.log(
            `      probe: vector with ${raw.result.length} series` +
              (raw.result.length > 0
                ? ` · first labels: ${JSON.stringify(raw.result[0].metric)}`
                : "")
          );
        } else {
          console.log(`      probe: ${raw.resultType}`);
        }
      } catch (e) {
        console.log(`      probe error: ${(e as Error).message}`);
      }
      continue;
    }
    // Dense series carry nulls for empty Prom buckets; stats read the
    // real samples only, but report the gap count alongside.
    const present = s.filter((v): v is number => v != null);
    const gaps = s.length - present.length;
    const min = Math.min(...present);
    const max = Math.max(...present);
    const last = present[present.length - 1];
    const meanV = present.reduce((a, b) => a + b, 0) / Math.max(1, present.length);
    console.log(
      `  ${p.slug.padEnd(18)} ` +
        `points=${s.length}${gaps > 0 ? ` (${gaps} empty)` : ""}  ` +
        `min=${fmt(min)}  max=${fmt(max)}  mean=${fmt(meanV)}  last=${fmt(last)}`
    );
  }

  console.log("");
}

function fmt(v: number | null) {
  if (v == null) return " .  ";
  return Number.isFinite(v) ? v.toFixed(3).padStart(8, " ") : "  NaN  ";
}

function parseDurationSec(d: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(d.trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
