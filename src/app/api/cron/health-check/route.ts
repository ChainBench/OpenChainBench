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
const PROVIDER_FRESH_THRESHOLD_SECONDS = 600; // 10 minutes. window during which we still treat the provider as live.

type ProviderState = {
  benchSlug: string;
  benchTitle: string;
  providerSlug: string;
  providerName: string;
  wasLive: boolean;
  isLive: boolean;
};

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode, no auth required
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
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

      const recentQ = `count_over_time(${metricName}${labelSelector}[${PROVIDER_FRESH_THRESHOLD_SECONDS}s])`;
      const pastQ = `count_over_time(${metricName}${labelSelector}[${PROVIDER_FRESH_THRESHOLD_SECONDS}s] offset ${LOOKBACK_SECONDS}s)`;

      const [now, past] = await Promise.all([
        prom.scalar(recentQ).catch(() => null),
        prom.scalar(pastQ).catch(() => null),
      ]);

      const isLive = (now ?? 0) > 0;
      const wasLive = (past ?? 0) > 0;

      if (isLive !== wasLive) {
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
