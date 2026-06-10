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
 *  This is the FIRST line of defense - it blocks obvious bad URLs in PR.
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
  // Reject embedded credentials: a contributor could otherwise stuff
  // basic-auth into the YAML that the site would send on every Prom call.
  if (u.username || u.password) return false;
  // URL.hostname preserves brackets for IPv6. Strip them before the
  // private-range tests, otherwise `[::1]`, `[fc00::1]`, `[::ffff:a9fe:a9fe]`
  // (= IPv4-mapped 169.254.169.254 / AWS IMDS) etc. would all pass.
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "::") return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false; // CGNAT
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return false; // IPv6 ULA
  if (/^fe80:/.test(host)) return false; // IPv6 link-local
  // IPv6 forms that re-encode private v4 addresses.
  if (/^::ffff:/.test(host)) return false; // IPv4-mapped
  if (/^64:ff9b:/.test(host)) return false; // NAT64
  if (/^2002:a9fe:/.test(host)) return false; // 6to4 over 169.254/16
  return true;
}

const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be lowercase, hyphenated");

/** PromQL. a non-empty string. We don't parse PromQL; that's Prometheus's job. */
const promql = z.string().min(1);

const region = z.enum(["us-east", "eu-west", "ap-southeast", "sgp", "global"]);

const queries = z
  .object({
    p50: promql.optional(),
    p90: promql.optional(),
    p99: promql.optional(),
    mean: promql.optional(),
    success: promql.optional(),
    sample_size: promql.optional(),
    series: promql.optional(),
    /** Optional slot-level companion queries. Solana-native benches set
     *  these to surface slot_delta p50/p99 alongside the ms columns. The
     *  ms numbers are wall-clock derived; slot_delta is the canonical
     *  on-chain measurement and what should be cited in methodology
     *  audits. */
    slot_p50: promql.optional(),
    slot_p99: promql.optional(),
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

/** Network-layer classification used by benches that mix L1 and L2 chains
 *  in the same provider set (e.g. network-fees). Powers the L1/L2/All
 *  toggle pill on the bench page so readers can split the leaderboard
 *  by execution layer without leaving the page. */
export const ProviderLayer = z.enum(["l1", "l2"]);

const provider = z.object({
  /** Stable identifier. also used as the metric label. */
  slug,
  /** Display name. */
  name: z.string().min(1),
  /** Optional one-liner shown under the name. */
  tag: z.string().optional(),
  /** Single-line explanation of how THIS provider's headline value is
   *  computed. Shown as a hover tooltip on the leaderboard row. Keep
   *  short: one sentence, plain English, no PromQL. */
  formula: z.string().min(1).max(240).optional(),
  /** Optional architectural category. When set, a badge appears next to
   *  the name so readers understand the comparison. */
  type: ProviderType.optional(),
  /** Optional network-layer classification. When set, a bench that mixes
   *  L1 and L2 providers (network-fees) renders an L1/L2/All toggle pill
   *  that filters the ledger by this field. */
  layer: ProviderLayer.optional(),
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

// Em-dash (—) and en-dash (–) are the classic "AI tells" that hurt our brand
// voice. The site is hand-authored, the YAMLs must read that way too. Plain
// hyphens stay legal because compound words ("head-lag", "L1-finality") need
// them. This refine runs on every copy field below.
const noAiDashes = (s: string) =>
  !s.includes("—") && !s.includes("–");
const noAiDashesMsg =
  "Avoid em or en dashes; use a comma, semicolon, or period instead";
const seoText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(noAiDashes, noAiDashesMsg);

export const SpecSchema = z
  .object({
    /* Identity */
    slug,
    number: z.string().regex(/^\d{3}$/, "Number must be a 3-digit string, e.g. \"001\""),
    title: seoText(1, 200),
    /** Optional SEO-tuned page title (browser tab + meta). Falls back to `title`. */
    seo_title: seoText(1, 200).optional(),
    /** Optional SEO-tuned meta description. Tight cap so Google does not
     *  truncate the SERP snippet mid-word (Google cuts around 155-160 chars). */
    // SEO-tight cap is 158 (Google truncates SERP at ~155-160) but enforcement
    // is at the metadata render layer via capDescription. Schema accepts up
    // to 320 so existing copy that intentionally packs long-tail keywords does
    // not fail Zod parse and break the bench page. capDescription trims to 158
    // for the meta tag, so Google still gets a clean snippet either way.
    seo_description: seoText(40, 320).optional(),
    /** Optional SSR-rendered intro paragraph displayed under the H1. Use it
     *  to spell out the exact long-tail phrases visitors search for ("time
     *  to finality", "sub-second finality", etc.) so the page ranks beyond
     *  its short title. */
    seo_intro: seoText(40, 2000).optional(),
    /** Optional warning callout rendered as a visible card right under
     *  the H1, BEFORE the leaderboard. Use when the metric is easy to
     *  misread — e.g. on benches where "lower is better" hides a
     *  fundamental trade-off (gas oracle inclusion-confidence oracles
     *  show larger gaps by design). Kept short so it can be read at a
     *  glance; expand the long version in seo_intro / FAQ. */
    disclaimer: seoText(20, 500).optional(),
    /** Optional FAQ section. Each pair generates a FAQPage JSON-LD entry +
     *  a visible block on the page. Capped at 12 entries to keep the page
     *  reasonable. */
    faq: z
      .array(
        z.object({
          q: seoText(1, 200),
          // Google FAQPage rich result caps answer text at ~999 chars; longer
          // answers silently drop from the rich result.
          a: seoText(1, 999),
        })
      )
      .max(12)
      .optional(),
    /** Optional per-chain or per-provider explainer blocks. Renders as
     *  H2-anchored sections below the main chart, one per slug. Each body
     *  is template-resolved so {{p50:slug}}, {{name:slug}} placeholders
     *  pick up live Prom data. Used on Blockchains-category benches to
     *  win long-tail "X chain finality time" queries that each map to
     *  a stable on-page anchor (#ethereum, #solana, ...). */
    per_chain_explainer: z
      .array(
        z.object({
          slug: z.string().min(1).max(50),
          h2: z.string().min(1).max(200),
          body: z.string().min(1).max(1000),
        })
      )
      .max(20)
      .optional(),
    subtitle: seoText(1, 400),
    category: Category,
    status: z.enum(["live", "draft"]).default("live"),

    /* Metric */
    metric: z.string().min(1).max(100),
    /** ms / s for latencies; pct for fees as percent of notional; bps for basis points; slots for Solana slot delta. */
    unit: z.enum(["ms", "s", "pct", "bps", "count", "slots", "usd"]),
    /** True when bigger numbers are better (coverage, count). Default false:
     * latency, fees, drift. every existing bench is "lower is better". */
    higher_is_better: z.boolean().default(false),

    /* Editorial copy */
    // Schema accepts up to schema.org's Dataset description ceiling (5000) so
    // existing rich abstracts do not fail Zod parse and break the bench page.
    // Google's Rich Results validator caps the field at ~1000 chars, so the
    // JSON-LD render path runs the abstract through capDescription(990) before
    // emitting it. Plain prose readers see the full 4000 in the page body.
    abstract: seoText(40, 4000),
    methodology: z.array(seoText(1, 500)).min(1).max(40),
    findings: z.array(seoText(1, 500)).max(40).default([]),
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
        /**
         * Cadence-aware freshness threshold for the cron health-check
         * alerter. A provider is treated as offline when no samples landed
         * in the last `expected_freshness_seconds`. Default 600 (10 min)
         * fits the high-frequency 10-30 s scrapers. Long-cadence benches
         * (5 min, 30 min, 1 h, 6 h) need to declare their own value here
         * - otherwise the cron sees them as offline most of the time and
         * spams slack on every probe gap.
         *
         * Rule of thumb: set this to roughly 2-3 x the scrape interval
         * so one missed cycle is tolerated, two missed cycles fire.
         */
        expected_freshness_seconds: z.number().int().positive().optional(),
      })
      .optional(),

    /* Optional drill-down dimensions. When set, the bench page renders
     * a tab selector for the dimension; queries get the corresponding
     * label filter injected server-side. Supported: chain, region.
     *
     * Values are constrained to a safe label-value alphabet because they
     * end up in PromQL selectors. escapePromLabelValue handles the wire
     * escape, but the regex below is defense-in-depth so a `value: "x\""`
     * never reaches the runtime in the first place. */
    dimensions: z
      .object({
        chain: z
          .array(
            z.object({
              value: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), // PromQL label value
              label: z.string().min(1).max(64), // display label
            })
          )
          .optional(),
        region: z
          .array(
            z.object({
              value: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
              label: z.string().min(1).max(64),
            })
          )
          .optional(),
        kind: z
          .array(
            z.object({
              value: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
              label: z.string().min(1).max(64),
            })
          )
          .optional(),
      })
      .optional(),

    /* Optional single PromQL returning one instant sample per
     * (provider[, chain][, region]) — e.g.
     *   avg by (provider, chain, region) (quantile_over_time(0.50, m[24h]))
     * Powers exact per-cell rankings (badge scoping, leadership claims)
     * in ONE Prom roundtrip instead of a chains × regions query fan-out.
     * Label values must match provider slugs / dimension values. */
    rank_matrix_query: z
      .string()
      .min(1)
      .max(2000)
      .refine(
        (q) => q.includes("provider"),
        "rank_matrix_query must group by the provider label"
      )
      .optional(),

    providers: z.array(provider).min(1),

    /**
     * Optional companion metrics rendered as switchable mini leaderboards
     * below the main table. Each panel declares a single Prometheus metric
     * name; the spec loader queries it per provider as
     * `<metric>{builder="<slug>"}` and stores the value. Used by the HL
     * frontends bench to surface execution quality, outage signal, taker
     * share, etc. without changing the main p50 headline.
     */
    metric_panels: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .max(40)
            .regex(/^[a-z][a-z0-9_]*$/, "Panel id must be lowercase snake_case"),
          label: z.string().min(1).max(80),
          description: z.string().max(300).optional(),
          metric: z.string().min(1).max(200),
          /** The PromQL label that holds each provider's slug. Defaults to
           *  "builder"; other benches may use "provider", "venue", etc. */
          label_key: z.string().min(1).max(40).default("builder"),
          unit: z.enum(["ms", "s", "pct", "bps", "count", "slots", "usd"]),
          higher_is_better: z.boolean().default(false),
        })
      )
      .max(8)
      .optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // A region-dimensioned bench without exact cell rankings would fall
    // back to cross-region-average badge logic, which is precisely the
    // bias the matrix exists to fix (a provider winning from one region
    // reads as the global leader). Refuse the spec instead.
    const realRegions = (spec.dimensions?.region ?? []).filter(
      (r) => r.value !== "all",
    );
    if (realRegions.length > 0 && !spec.rank_matrix_query) {
      ctx.addIssue({
        code: "custom",
        path: ["rank_matrix_query"],
        message:
          "Benches declaring dimensions.region must provide rank_matrix_query so badge claims are scoped per region",
      });
    }
  });

export type Spec = z.infer<typeof SpecSchema>;
export type SpecProvider = z.infer<typeof provider>;
