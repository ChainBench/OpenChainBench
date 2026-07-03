#!/usr/bin/env tsx
/**
 * `pnpm rpc-hub:dry-run`. Builds the /rpc hub cohort snapshot exactly
 * the way the materialize worker does — from the worker-published bench
 * blobs in the store, zero Prometheus queries — and prints the totals
 * plus a per-chain summary. Useful when tweaking the snapshot shape or
 * checking that every `<chain>-rpc` blob resolves before a deploy.
 *
 * Env: KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_* / OCB_REDIS_URL),
 * same as the worker. Pass `--json` to dump the full snapshot.
 */

import { buildRpcHubSnapshotFresh } from "../src/lib/rpc-hub-stats";
import { storeConfigured } from "../src/lib/materialize/store";

async function main() {
  if (!storeConfigured()) {
    console.error(
      "No store configured. Set KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_* / OCB_REDIS_URL).",
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const snap = await buildRpcHubSnapshotFresh();
  if (!snap) {
    console.error(
      "Builder returned null: no `-rpc` bench blob resolved. Is the worker sweeping the RPC cluster?",
    );
    process.exit(1);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }

  const bytes = Buffer.byteLength(JSON.stringify(snap), "utf8");
  console.log(`\n=== rpc-hub snapshot dry run (${Date.now() - t0} ms) ===\n`);
  console.log(
    `totals: chains=${snap.totals.chains}  uniqueProviders=${snap.totals.uniqueProviders}  regions=${snap.totals.regions}`,
  );
  console.log(`blob size: ${(bytes / 1024).toFixed(1)} KB\n`);

  console.log("CHAINS:");
  for (const c of snap.chains) {
    const best = c.best
      ? `${c.best.providerName} @ ${c.best.p50Ms} ms`
      : "—";
    const regions = (["us-east", "eu-west", "sgp"] as const)
      .map((r) => {
        const b = c.regions[r];
        return `${r}=${b ? `${b.provider}@${b.p50Ms}` : "—"}`;
      })
      .join("  ");
    console.log(
      `  ${c.slug.padEnd(16)} providers=${String(c.providerCount).padStart(2)}  best=${best.padEnd(28)} ${regions}  series=${c.series?.length ?? 0}pt`,
    );
  }

  const detail = snap.chains[0];
  console.log(`\nDETAIL · ${detail.slug} (${detail.name}):`);
  for (const p of detail.providers) {
    console.log(
      `  ${p.provider.padEnd(14)} p50=${String(p.p50Ms).padStart(7)} ms  p99=${p.p99Ms != null ? String(p.p99Ms).padStart(7) : "      —"}  ok=${p.successPct != null ? `${p.successPct.toFixed(1)}%` : "—"}  n=${p.sampleSize ?? "—"}  regions={us-east:${p.regions["us-east"] ?? "—"}, eu-west:${p.regions["eu-west"] ?? "—"}, sgp:${p.regions.sgp ?? "—"}}`,
    );
  }

  console.log("\nPIVOT (top 10 by coverage):");
  for (const r of snap.providersPivot.slice(0, 10)) {
    console.log(
      `  ${r.provider.padEnd(14)} chains=${String(r.chainsCovered).padStart(2)}/${snap.totals.chains}  medianRank=#${r.medianRank}  medianP50=${r.medianP50Ms} ms`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
