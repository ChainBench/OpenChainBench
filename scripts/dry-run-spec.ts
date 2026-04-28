#!/usr/bin/env tsx
/**
 * `pnpm spec:dry-run <slug>` — fetches a single benchmark from Prometheus
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
    console.error("No prometheus.url in spec and PROMETHEUS_URL unset.");
    process.exit(1);
  }

  const prom = new Prometheus(url);

  console.log(`\n=== Dry run · ${spec.slug} → ${url} ===\n`);
  for (const p of spec.providers) {
    const q = p.queries ?? {};
    const [p50, p90, p99, success, sampleSize] = await Promise.all([
      q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
      q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
      q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
      q.success ? prom.scalar(q.success) : Promise.resolve(null),
      q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
    ]);
    console.log(`  ${p.slug.padEnd(18)} ` +
      `p50=${fmt(p50)}  p90=${fmt(p90)}  p99=${fmt(p99)}  ` +
      `success=${success != null ? `${(success * 100).toFixed(2)}%` : "—"}  ` +
      `n=${sampleSize ?? "—"}`);
  }
  console.log("");
}

function fmt(v: number | null) {
  if (v == null) return "  —  ";
  return String(Math.round(v)).padStart(5, " ");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
