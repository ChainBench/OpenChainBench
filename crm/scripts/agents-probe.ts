/**
 * Run the Vercel agent-traffic loader once and print what it returns.
 *
 * The queries are undocumented (see lib/vercel-obs.ts), so this exists to
 * prove the loader against the live API without a full refresh.
 *
 *   VERCEL_API_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... \
 *     pnpm exec tsx scripts/agents-probe.ts
 */
import { loadAgentTraffic, vercelObsConfigured } from "../lib/vercel-obs";

async function main() {
  if (!vercelObsConfigured()) {
    console.error("not configured: set VERCEL_API_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID");
    process.exit(2);
  }
  const t = await loadAgentTraffic();
  console.log(
    `window ${t.windowDays} d, first day with data ${t.firstDayWithData ?? "none"}\n` +
      `total ${t.totalRequests.toLocaleString()}  ` +
      `ai ${t.aiRequests.toLocaleString()}  ` +
      `ai without ${t.topAiBot ?? "-"} ${t.aiRequestsExcludingTop.toLocaleString()}\n`,
  );
  console.log("categories:");
  for (const c of t.categories) console.log(`  ${c.requests.toString().padStart(9)}  ${c.category}`);
  console.log("\ntop bots:");
  for (const b of t.bots.slice(0, 15)) {
    console.log(`  ${b.requests.toString().padStart(9)}  ${b.sharePct.toFixed(1).padStart(5)}%  ${b.bot}  (${b.category || "unclassified"})`);
  }
  console.log(`\ntop AI paths, ${t.aiPathsWindowDays} d:`);
  for (const p of t.aiPaths.slice(0, 10)) console.log(`  ${p.requests.toString().padStart(9)}  ${p.path}`);
  console.log("\ndaily (non-zero):");
  for (const d of t.daily.filter((d) => d.ai + d.search + d.unclassified + d.other > 0)) {
    console.log(`  ${d.day}  ai ${d.ai.toString().padStart(7)}  search ${d.search.toString().padStart(6)}  other ${d.other.toString().padStart(6)}  unclassified ${d.unclassified.toString().padStart(7)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
