import { NextResponse, type NextRequest } from "next/server";
import { SITE } from "@/data/site";
import { getCapitalHub, type ChainRow } from "@/lib/capital-hub";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

/**
 * GET /api/capital: the /capital hub as JSON, the same rows the page and
 * its Markdown view render (src/lib/capital-hub.ts), for agents and
 * spreadsheets that want the cohorts in one call instead of five
 * /api/stat reads plus two history blobs.
 *
 * Same gating as the page: a bench this deployment does not serve (the
 * dev-only set in src/lib/removed-benches.ts) contributes no source entry
 * and its fields are absent from every row, not null, so a production
 * consumer never sees a key it cannot resolve to a bench URL. The ranked
 * fields and the muted "outside the ranked cohort" fields are separate
 * keys, as on the page: `stablesNet30d` is bench 275's ranked value,
 * `stablesNet30dOutside` the history blob's value for a chain the bench
 * does not rank. Every number is CC BY 4.0. No secrets, no keys.
 */

export const dynamic = "force-dynamic";

const CACHE = "public, max-age=300, s-maxage=300";

const CCTP_KEYS = ["cctpScope", "cctpNet7d", "cctpIn7d", "cctpOut7d"] as const;
const FEES_KEYS = ["inFeesCohort", "fees30d", "revenue30d", "fees30dOutside", "revenue30dOutside"] as const;

function stripped(row: ChainRow, drop: readonly (keyof ChainRow)[]): Partial<ChainRow> {
  const out: Partial<ChainRow> = { ...row };
  for (const k of drop) delete out[k];
  return out;
}

export async function GET(req: NextRequest) {
  const rl = rateLimit(clientKey(req, "capital"), 120, 60, req);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const hub = await getCapitalHub();
  // A bench that is not served here, or that did not load this time, has
  // no column on the page either: its keys are absent, not null, so a
  // `cctpScope` computed against an empty scanned set never reaches a consumer.
  const liveSlugs = new Set(hub.benches.filter((b) => b.live).map((b) => b.slug));
  const drop: (keyof ChainRow)[] = [
    ...(liveSlugs.has("usdc-corridor-flows") ? [] : CCTP_KEYS),
    ...(liveSlugs.has("chain-fees-revenue") ? [] : FEES_KEYS),
  ];

  const body = {
    page: `${SITE.url}/capital`,
    license: "CC-BY-4.0",
    asOf: hub.asOf,
    /** One entry per bench this deployment serves; `live` false with `failed` true is a transient load failure. */
    sources: hub.benches.map((b) => ({
      slug: b.slug,
      title: b.title,
      live: b.live,
      failed: b.failed,
      page: `${SITE.url}/benchmarks/${b.slug}`,
      json: `${SITE.url}/api/stat/${b.slug}`,
    })),
    history: {
      valuation: "https://kv.openchainbench.com/aggregate/valuation/history.json",
      chains: "https://kv.openchainbench.com/aggregate/chains/history.json",
      days: hub.historyDays,
    },
    chains: drop.length > 0 ? hub.chains.map((c) => stripped(c, drop)) : hub.chains,
    stableFlowShares: hub.stableFlowShares,
    protocols: hub.protocols,
    divergences: hub.divergences,
    perps: hub.perps,
    openInterest: {
      perpDexes: hub.perpOi,
      predictionMarkets: hub.pmOi,
    },
    leaders: {
      bridgedTvl: hub.leaders.bridgedTvl?.slug ?? null,
      stableInflow: hub.leaders.stableInflow?.slug ?? null,
      lowestPfProtocol: hub.leaders.lowestPfProtocol?.slug ?? null,
      lowestPfPerp: hub.leaders.lowestPfPerp?.slug ?? null,
      pmOi: hub.leaders.pmOi?.slug ?? null,
    },
  };

  return NextResponse.json(body, {
    headers: {
      "cache-control": CACHE,
      "access-control-allow-origin": "*",
    },
  });
}
