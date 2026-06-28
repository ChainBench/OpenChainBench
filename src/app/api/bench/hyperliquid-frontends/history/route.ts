/**
 * Window-scoped leaderboard for the Hyperliquid frontends bench.
 *
 * GET /api/bench/hyperliquid-frontends/history?window=24h|7d|30d|90d|180d|1y|all
 *
 * Routing rule:
 *   - windows ≤ 30d  → live Prom snapshot via getBenchmark() + metric_panels
 *   - windows > 30d  → archive blob written by the Go hl-archive service
 *
 * The ≤30d branch deliberately reuses the same panel ids the bench page
 * reads from (`volume_7d` / `volume_30d` for volume, headline slots for
 * 24h fees+volume) so the API and the on-page ledger can never disagree
 * about the leaderboard for a shared window.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBenchmark } from "@/data/benchmarks";
import { getArchive } from "@/lib/hl-archive-store";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import type {
  HlArchiveHistoryResponse,
  HlArchiveLongWindow,
  HlArchiveRankedRow,
  HlArchiveWindow,
} from "@/types/hl-archive";
import {
  HL_ARCHIVE_LONG_WINDOWS,
  HL_ARCHIVE_WINDOWS,
} from "@/types/hl-archive";

export const runtime = "nodejs";
export const revalidate = 60;

const BENCH_SLUG = "hyperliquid-frontends";

const CACHE_HEADER = "public, s-maxage=60, stale-while-revalidate=300";

function isWindow(v: string | null): v is HlArchiveWindow {
  return v !== null && (HL_ARCHIVE_WINDOWS as readonly string[]).includes(v);
}

function isLongWindow(w: HlArchiveWindow): w is HlArchiveLongWindow {
  return (HL_ARCHIVE_LONG_WINDOWS as readonly string[]).includes(w);
}

function rank(
  rows: Omit<HlArchiveRankedRow, "rank">[],
): HlArchiveRankedRow[] {
  return [...rows]
    .sort((a, b) => b.volume_usd - a.volume_usd)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

type PromPanelKey = "fees" | "volume";

/** Panel id to read for a given (metric, window) pair on the HL bench.
 *  Null means "use the headline slot" — only 24h fees+volume live there. */
function promPanelId(metric: PromPanelKey, window: HlArchiveWindow): string | null {
  if (window === "24h") return null;
  if (metric === "fees") {
    if (window === "7d") return "revenue_7d";
    if (window === "30d") return "revenue_30d";
  }
  if (metric === "volume") {
    if (window === "7d") return "volume_7d";
    if (window === "30d") return "volume_30d";
  }
  return null;
}

async function buildFromProm(
  window: HlArchiveWindow,
): Promise<HlArchiveHistoryResponse | null> {
  const bench = await getBenchmark(BENCH_SLUG);
  if (!bench) return null;

  const feesPanelId = promPanelId("fees", window);
  const volPanelId = promPanelId("volume", window);
  const panels = bench.metricPanels ?? [];
  const feesPanel = feesPanelId
    ? (panels.find((p) => p.id === feesPanelId) ?? null)
    : null;
  const volPanel = volPanelId
    ? (panels.find((p) => p.id === volPanelId) ?? null)
    : null;

  const rows: Omit<HlArchiveRankedRow, "rank">[] = [];
  for (const r of bench.results) {
    if (r.availability === "unavailable") continue;
    const fees =
      window === "24h" ? r.ms.p50 : (feesPanel?.values[r.slug] ?? 0);
    const volume =
      window === "24h" ? r.ms.p90 : (volPanel?.values[r.slug] ?? 0);
    if (fees === 0 && volume === 0) continue;
    rows.push({
      slug: r.slug,
      name: r.name,
      volume_usd: volume,
      fees_usd: fees,
      fills: 0,
    });
  }

  return {
    window,
    source: "prom",
    updated_at: bench.lastRunAt,
    rows: rank(rows),
  };
}

export async function GET(req: NextRequest) {
  const rl = rateLimit(clientKey(req, "hl-archive-history"), 120, 60, req);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(req.url);
  const windowParam = url.searchParams.get("window");
  if (!isWindow(windowParam)) {
    return NextResponse.json(
      { error: "bad_window", allowed: HL_ARCHIVE_WINDOWS },
      { status: 400, headers: { "cache-control": "public, s-maxage=60" } },
    );
  }
  const window = windowParam;

  if (!isLongWindow(window)) {
    const payload = await buildFromProm(window);
    if (!payload) {
      return NextResponse.json(
        { error: "bench_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(payload, { headers: { "cache-control": CACHE_HEADER } });
  }

  const archive = await getArchive();
  if (!archive) {
    return NextResponse.json(
      {
        error: "archive_pending",
        message:
          "Long-window archive not yet available. Backfill is running on the hl-archive service; data will appear within a few hours.",
        window,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const rows: Omit<HlArchiveRankedRow, "rank">[] = [];
  for (const [addr, b] of Object.entries(archive.builders)) {
    const w = b.windows[window];
    if (!w) continue;
    if (w.volume_usd === 0 && w.fees_usd === 0 && w.fills === 0) continue;
    rows.push({
      slug: addr,
      name: b.name,
      volume_usd: w.volume_usd,
      fees_usd: w.fees_usd,
      fills: w.fills,
    });
  }

  const payload: HlArchiveHistoryResponse = {
    window,
    source: "archive",
    updated_at: archive.updated_at,
    rows: rank(rows),
  };
  return NextResponse.json(payload, { headers: { "cache-control": CACHE_HEADER } });
}
