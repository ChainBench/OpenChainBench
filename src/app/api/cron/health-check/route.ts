import { NextResponse, type NextRequest } from "next/server";
import { getBenchmarkSlugs } from "@/data/benchmarks";
import { getSpecs } from "@/lib/spec";
import { Prometheus } from "@/lib/prometheus";

export const runtime = "nodejs";
// Always read live state from prom. ISR cache here would defeat the
// alert. Vercel calls this from the cron entry in vercel.json every 5 min.
export const dynamic = "force-dynamic";

/**
 * Cron health-check + slack alerter.
 *
 * Walks every live bench, asks prometheus two questions per provider:
 *   1. Was the provider returning data 6 minutes ago? (prom range query)
 *   2. Is it returning data now?
 *
 * Transitions trigger a slack message. Without state storage we use prom
 * itself as the source-of-truth: comparing "now" vs "6 min ago" gives us
 * the same up/down/recovered edges Alertmanager would compute, with one
 * fewer service to run.
 *
 * Wiring (operator):
 *   1. Set `SLACK_WEBHOOK_URL` in vercel env (production scope only).
 *   2. Set `CRON_SECRET` in vercel env, used to gate this route.
 *   3. The vercel.json cron config posts here every 5 minutes with
 *      `Authorization: Bearer ${CRON_SECRET}`.
 *
 * If `SLACK_WEBHOOK_URL` is unset the route runs in dry-mode: it still
 * computes the transitions and returns them as JSON, useful for testing
 * without spamming the channel.
 */

const LOOKBACK_SECONDS = 360; // 6 minutes. covers the 5-minute cron + slack delivery slack.
const DEFAULT_FRESH_THRESHOLD_SECONDS = 600; // 10 minutes. only used when a bench yml doesn't declare its own.
// Hysteresis: alert only when the offline state has been observed for
// HYSTERESIS_OFFSET_SECONDS continuously. Concretely we sample the
// "still offline?" question at offset 0 AND offset HYSTERESIS, and
// require both to agree before firing. This eats single-cycle blips
// (a harness reboot, a flaky upstream that recovers in <5 min) which
// would otherwise spam slack on every transient hiccup. Same logic
// gates recovery alerts so a flapping provider doesn't generate
// up/down/up/down noise.
const HYSTERESIS_OFFSET_SECONDS = 600; // ~2 cron cycles of confirmation.

type ProviderState = {
  benchSlug: string;
  benchTitle: string;
  providerSlug: string;
  providerName: string;
  wasLive: boolean;
  isLive: boolean;
};

function isAuthorized(req: NextRequest): boolean {
  // Trim both sides. The vercel UI / `vercel env add` paste flow has
  // historically appended a trailing newline to multi-line copies, which
  // would otherwise produce a constant 401 with no obvious explanation.
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return true; // dev mode, no auth required
  const header = (req.headers.get("authorization") ?? "").trim();
  return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const promUrl = process.env.PROMETHEUS_URL?.trim();
  if (!promUrl) {
    return NextResponse.json({ error: "PROMETHEUS_URL not set" }, { status: 500 });
  }

  const prom = new Prometheus(promUrl);
  const slugs = await getBenchmarkSlugs();
  const specs = await getSpecs();
  const liveSpecs = specs.filter(
    (s) => slugs.includes(s.slug) && s.status === "live",
  );

  const transitions: ProviderState[] = [];

  for (const spec of liveSpecs) {
    // Per-bench freshness window. High-freq scrapers (10-30 s) keep the
    // 10 min default. Slow scrapers (5 min, 30 min, 1 h, 6 h) declare
    // their own `prometheus.expected_freshness_seconds` so the cron
    // doesn't treat their normal idle stretches as outages.
    const threshold =
      spec.prometheus?.expected_freshness_seconds ?? DEFAULT_FRESH_THRESHOLD_SECONDS;
    for (const provider of spec.providers) {
      const q = provider.queries?.p50;
      if (!q) continue;

      // For the freshness probe we just need a metric name to ask prom
      // "do you have any sample within X seconds for this label set".
      // The trick: `count_over_time(metric{...}[Xs])` returns >0 when
      // prom received at least one sample in the window, 0 otherwise.
      const metricName = extractFirstMetric(q);
      const labelSelector = extractLabelSelector(q);
      if (!metricName) continue;

      // changes() over count_over_time(): prom scrapes the harness every
      // 15 s by default, so count_over_time stays > 0 forever even when
      // the harness has stopped pulling fresh data from its upstream
      // source (gauges keep the last value, prom keeps recording it).
      // changes() counts how many distinct values landed in the window,
      // which correctly drops to 0 when the value stalls. Works for both
      // gauges (value moves on each update) and counters (increments are
      // changes), so we get one consistent freshness probe per metric type.
      //
      // Three samples per provider for the hysteresis check:
      //   - now     : "is it alive right now?"
      //   - confirm : "was it alive (or dead) 10 min ago too?"        (HYSTERESIS_OFFSET)
      //   - past    : "was it the OPPOSITE state 16 min ago?"         (LOOKBACK + HYSTERESIS)
      // We only alert when `now == confirm` (state sustained for the
      // hysteresis window) AND `past` is the opposite (it really did
      // flip). Single-cycle blips show now != confirm and are dropped.
      const recentQ = `changes(${metricName}${labelSelector}[${threshold}s])`;
      const confirmQ = `changes(${metricName}${labelSelector}[${threshold}s] offset ${HYSTERESIS_OFFSET_SECONDS}s)`;
      const pastQ = `changes(${metricName}${labelSelector}[${threshold}s] offset ${LOOKBACK_SECONDS + HYSTERESIS_OFFSET_SECONDS}s)`;

      const [now, confirm, past] = await Promise.all([
        // For multi-series metrics the spec's p50 query already narrows
        // to a single provider via labels, but if changes() still returns
        // a vector we want any-series-alive as the live signal.
        prom.scalar(`max(${recentQ})`).catch(() => null),
        prom.scalar(`max(${confirmQ})`).catch(() => null),
        prom.scalar(`max(${pastQ})`).catch(() => null),
      ]);

      const isLive = (now ?? 0) > 0;
      const isLiveConfirmed = (confirm ?? 0) > 0;
      const wasLive = (past ?? 0) > 0;

      // Sustained transition only: both "now" and "10 min ago" agree on
      // the new state, AND the older "past" sample disagreed.
      const sustainedFlip = isLive === isLiveConfirmed && isLive !== wasLive;

      if (sustainedFlip) {
        transitions.push({
          benchSlug: spec.slug,
          benchTitle: spec.title,
          providerSlug: provider.slug,
          providerName: provider.name,
          wasLive,
          isLive,
        });
      }
    }
  }

  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  const sent: { provider: string; text: string }[] = [];
  if (webhook && transitions.length > 0) {
    for (const t of transitions) {
      const emoji = t.isLive ? "✅" : "🔴";
      const verb = t.isLive ? "back online" : "offline";
      const text = `${emoji} *${t.providerName}* ${verb} on \`${t.benchSlug}\`\nbench: <https://openchainbench.com/benchmarks/${t.benchSlug}|${t.benchTitle}>`;
      try {
        await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        sent.push({ provider: `${t.benchSlug}/${t.providerSlug}`, text });
      } catch {
        // best effort - don't break the cron on a single slack failure
      }
    }
  }

  return NextResponse.json({
    checked: liveSpecs.length,
    transitions: transitions.length,
    sent: sent.length,
    dryRun: !webhook,
    transitionsList: transitions,
  });
}

// Pull the first raw metric identifier out of a promql query. Mirrors the
// helper in lib/prometheus.ts but specialised to also capture the label
// selector that follows so we can reuse it in the freshness probe.
function extractFirstMetric(q: string): string | null {
  const m = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/.exec(q);
  if (!m) {
    const bare = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/.exec(q);
    return bare ? bare[1] : null;
  }
  return m[1];
}

function extractLabelSelector(q: string): string {
  const m = /\{[^{}]*\}/.exec(q);
  return m ? m[0] : "";
}
