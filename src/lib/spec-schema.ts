/**
 * Single source of truth for the benchmark-spec contract.
 *
 * A spec is a self-contained YAML file: editorial metadata + Prometheus
 * queries. Everything that appears on a benchmark page comes from one of
 * these. there are no hidden mocks.
 *
 * The Zod schema below is consumed in three places:
 *   1. The runtime loader (src/lib/spec.ts) parses every YAML through it.
 *   2. `pnpm validate` (scripts/validate-specs.ts) lints all specs in CI.
 *   3. The TypeScript types are derived from the schema and exported so
 *      app code never drifts from the wire format.
 */

import { z } from "zod";

/** Schema-time guard for spec-declared Prometheus URLs. Rejects non-https,
 *  loopback, RFC1918, link-local (incl. AWS/GCP metadata at 169.254.x),
 *  ULA and CGNAT literals.
 *
 *  This is the FIRST line of defense — it blocks obvious bad URLs in PR.
 *  The runtime client (src/lib/prometheus.ts) also DNS-resolves the hostname
 *  before every fetch and rejects if it lands on a private address, so a
 *  hostname that *currently* resolves to a public IP can't get repointed to
 *  169.254.169.254 later without the fetch failing.
 *
 *  Federation context: every contributor declares their own
 *  `prometheus.url` in the YAML (https://<their-prom>.example). Maintainers
 *  do a manual review on PR; this guard plus the runtime DNS check is the
 *  belt-and-suspenders pair. */
function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "::") return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false; // CGNAT
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return false; // IPv6 ULA
  if (/^fe80:/.test(host)) return false; // IPv6 link-local
  return true;
}

const slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be lowercase, hyphenated");

/** PromQL. a non-empty string. We don't parse PromQL; that's Prometheus's job. */
const promql = z.string().min(1);

const region = z.enum(["us-east", "eu-west", "ap-southeast", "global"]);

const queries = z
  .object({
    p50: promql.optional(),
    p90: promql.optional(),
    p99: promql.optional(),
    mean: promql.optional(),
    success: promql.optional(),
    sample_size: promql.optional(),
    series: promql.optional(),
    regions: z
      .array(
        z.object({
          region,
          p50: promql.optional(),
          /** Optional per-region time-series. When present, the chart's
           * region selector lets readers slice the multi-line plot by
           * region. Without this, only the global series renders. */
          series: promql.optional(),
        })
      )
      .optional(),
  })
  .optional();

/** Architectural category. Surfaced as a badge next to the provider
 *  name on the bench detail page + share-card so readers know whether
 *  numbers compare like-for-like. Used heavily on bridge benches where
 *  aggregators (LiFi) and single protocols (Debridge) are inherently
 *  not apples-to-apples on latency. */
export const ProviderType = z.enum([
  "protocol",   // single bridge / single data feed (Debridge, Codex)
  "aggregator", // queries N underlying providers (LiFi, Mobula's aggregator side)
  "intent",     // intent / settlement layer (Mobula intents, Mayan)
  "relay",      // relayer / settlement network (Relay, deBridge solver layer)
]);

const provider = z.object({
  /** Stable identifier. also used as the metric label. */
  slug,
  /** Display name. */
  name: z.string().min(1),
  /** Optional one-liner shown under the name. */
  tag: z.string().optional(),
  /** Optional architectural category. When set, a badge appears next to
   *  the name so readers understand the comparison. */
  type: ProviderType.optional(),
  /** Optional secondary metric (e.g. "Chains covered") shown in the table. */
  secondary: z
    .object({ label: z.string(), value: z.string() })
    .optional(),
  queries,
});

const window = z
  .string()
  .regex(/^\d+[smhd]$/, "Window must look like '24h', '1d', '15m', '600s'");

export const Category = z.enum([
  "Aggregators",
  "Bridges",
  "Blockchains",
  "Trading",
  "Wallets",
  "RPCs",
]);

export const SpecSchema = z
  .object({
    /* Identity */
    slug,
    number: z.string().regex(/^\d{3}$/, "Number must be a 3-digit string, e.g. \"001\""),
    title: z.string().min(1),
    /** Optional SEO-tuned page title (browser tab + meta). Falls back to `title`. */
    seo_title: z.string().min(1).optional(),
    subtitle: z.string().min(1),
    category: Category,
    status: z.enum(["live", "draft"]).default("live"),

    /* Metric */
    metric: z.string().min(1),
    /** ms / s for latencies; pct for fees as percent of notional; bps for basis points. */
    unit: z.enum(["ms", "s", "pct", "bps", "count"]),
    /** True when bigger numbers are better (coverage, count). Default false:
     * latency, fees, drift. every existing bench is "lower is better". */
    higher_is_better: z.boolean().default(false),

    /* Editorial copy */
    abstract: z.string().min(40),
    methodology: z.array(z.string()).min(1),
    findings: z.array(z.string()).default([]),
    source: z.url(),

    /* Data source. OpenChainBench is a federation: every contributor
     * declares the Prometheus their harness publishes to. Schema-time
     * isPublicHttpsUrl + runtime DNS-resolve guard in the Prom client
     * defend the site from SSRF via a malicious or DNS-rebound URL. */
    prometheus: z
      .object({
        url: z
          .url()
          .refine(isPublicHttpsUrl, "Prometheus URL must be https:// and resolve to a public host (no loopback / RFC1918 / link-local / metadata IPs)")
          .optional(),
        window: window.optional(),
      })
      .optional(),

    /* Optional drill-down dimensions. When set, the bench page renders
     * a tab selector for the dimension; queries get the corresponding
     * label filter injected server-side. Supported: chain, region. */
    dimensions: z
      .object({
        chain: z
          .array(
            z.object({
              value: z.string().min(1), // PromQL label value, e.g. "solana"
              label: z.string().min(1), // display label, e.g. "Solana"
            })
          )
          .optional(),
        region: z
          .array(
            z.object({
              value: z.string().min(1), // PromQL label value, e.g. "eu-west"
              label: z.string().min(1), // display label, e.g. "EU West"
            })
          )
          .optional(),
      })
      .optional(),

    providers: z.array(provider).min(1),
  })
  .strict();

export type Spec = z.infer<typeof SpecSchema>;
export type SpecProvider = z.infer<typeof provider>;
