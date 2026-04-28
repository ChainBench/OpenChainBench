/**
 * Single source of truth for the benchmark-spec contract.
 *
 * A spec is a self-contained YAML file: editorial metadata + Prometheus
 * queries. Everything that appears on a benchmark page comes from one of
 * these — there are no hidden mocks.
 *
 * The Zod schema below is consumed in three places:
 *   1. The runtime loader (src/lib/spec.ts) parses every YAML through it.
 *   2. `pnpm validate` (scripts/validate-specs.ts) lints all specs in CI.
 *   3. The TypeScript types are derived from the schema and exported so
 *      app code never drifts from the wire format.
 */

import { z } from "zod";

const slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be lowercase, hyphenated");

/** PromQL — a non-empty string. We don't parse PromQL; that's Prometheus's job. */
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
      .array(z.object({ region, p50: promql.optional() }))
      .optional(),
  })
  .optional();

const provider = z.object({
  /** Stable identifier — also used as the metric label. */
  slug,
  /** Display name. */
  name: z.string().min(1),
  /** Optional one-liner shown under the name. */
  tag: z.string().optional(),
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
  "Data",
  "Wallets",
  "RPCs",
]);

export const SpecSchema = z
  .object({
    /* Identity */
    slug,
    number: z.string().regex(/^\d{3}$/, "Number must be a 3-digit string, e.g. \"001\""),
    title: z.string().min(1),
    subtitle: z.string().min(1),
    category: Category,
    status: z.enum(["live", "draft"]).default("live"),

    /* Metric */
    metric: z.string().min(1),
    /** ms / s for latencies; bps for fees in basis points. */
    unit: z.enum(["ms", "s", "bps"]),

    /* Editorial copy */
    abstract: z.string().min(40),
    methodology: z.array(z.string()).min(1),
    findings: z.array(z.string()).default([]),
    source: z.url(),

    /* Data source */
    prometheus: z
      .object({ url: z.url().optional(), window: window.optional() })
      .optional(),

    providers: z.array(provider).min(1),
  })
  .strict();

export type Spec = z.infer<typeof SpecSchema>;
export type SpecProvider = z.infer<typeof provider>;
