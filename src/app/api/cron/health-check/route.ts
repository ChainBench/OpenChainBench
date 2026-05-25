import { timingSafeEqual } from "node:crypto";
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
  const header = (req.headers.get("authorization") ?? "").trim();

  // Fail closed in production: without a configured CRON_SECRET the
  // cron route would otherwise accept any request, exposing the alert
  // and prom-probe machinery to anyone who guesses the URL. Keep the
  // permissive "any request OK" fall-through for local dev only.
  if (!secret) {
    if (process.env.NODE_ENV === "production") return false;
    return true;
  }

  // Constant-time comparison. The previous `header === \`Bearer ${secret}\``
  // shortcut leaked the secret one byte at a time under a remote timing
  // attack (response latency varied with prefix-match length). Pad to
  // equal length before comparing so timingSafeEqual never throws on
  // mismatched buffer sizes, then AND the equality with a length check
  // so a shorter-but-prefix-matching header still fails.
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  const padded = Buffer.alloc(expected.length);
  provided.copy(padded);
  const lengthMatches = provided.length === expected.length;
  return timingSafeEqual(padded, expected) && lengthMatches;
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
      const metricName = extractFirstMetric(q);
      const labelSelector = extractLabelSelector(q);
      if (!metricName) continue;

      // present_over_time(metric[Xs]): returns 1 if prom actually
      // scraped a sample in the window, 0 otherwise. Scrape-existence
      // probe, NOT value-change probe.
      //
      // Previous implementation used `changes(metric[Xs])` which
      // returned 0 for "value didn't move" — but for stable gauges
      // (USDT peg deviation = 0bp, validator-yield median stable
      // between epochs, low-traffic counters not incrementing) the
      // harness was alive and scraping fresh samples, just always
      // emitting the same value. Result: dozens of flapping
      // online/offline alerts per night for benches that were
      // perfectly healthy.
      //
      // present_over_time is the correct probe because it triggers
      // off scrape success (prom records a sample), not value motion.
      // When a target dies, prom stops getting samples and after the
      // threshold window present_over_time drops to 0. Works
      // identically for gauges, counters, and histograms.
      //
      // Three samples per provider for the hysteresis check:
      //   - now     : "is it alive right now?"
      //   - confirm : "was it alive (or dead) 10 min ago too?"        (HYSTERESIS_OFFSET)
      //   - past    : "was it the OPPOSITE state 16 min ago?"         (LOOKBACK + HYSTERESIS)
      // We only alert when `now == confirm` (state sustained for the
      // hysteresis window) AND `past` is the opposite (it really did
      // flip). Single-cycle blips show now != confirm and are dropped.
      const recentQ = `present_over_time(${metricName}${labelSelector}[${threshold}s])`;
      const confirmQ = `present_over_time(${metricName}${labelSelector}[${threshold}s] offset ${HYSTERESIS_OFFSET_SECONDS}s)`;
      const pastQ = `present_over_time(${metricName}${labelSelector}[${threshold}s] offset ${LOOKBACK_SECONDS + HYSTERESIS_OFFSET_SECONDS}s)`;

      const [now, confirm, past] = await Promise.all([
        // For multi-series metrics the spec's p50 query already narrows
        // to a single provider via labels, but if the result is still
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
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          // Slack returns 4xx (bad webhook, archived channel, payload
          // shape) or 5xx with a plain text body. Surface in the vercel
          // function logs so an invalid webhook doesn't disappear into
          // a silent void - this is the *alerting* channel, so a dead
          // alerter is the worst possible failure mode.
          const body = await res.text().catch(() => "");
          console.error(
            `slack webhook ${res.status} for ${t.benchSlug}/${t.providerSlug}: ${body.slice(0, 200)}`,
          );
        } else {
          sent.push({ provider: `${t.benchSlug}/${t.providerSlug}`, text });
        }
      } catch (err) {
        console.error(
          `slack webhook network error for ${t.benchSlug}/${t.providerSlug}:`,
          err,
        );
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
