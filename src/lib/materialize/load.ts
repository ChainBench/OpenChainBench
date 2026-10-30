/**
 * Next-free benchmark loader core.
 *
 * Everything here runs in BOTH contexts: the Next.js site (wrapped in
 * unstable_cache layers by src/lib/spec.ts) and the standalone
 * materialization worker on Railway (which imports this directly and
 * must never pull next/* into its bundle). Do not import next/react
 * here; persistence side effects are injected via hooks.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type {
  Benchmark,
  CellRankEntry,
  MetricPanel,
  ProviderResult,
} from "@/types/benchmark";
import { Prometheus } from "@/lib/prometheus";
import { specValueKind } from "@/lib/value-window";
import { pickChainLeader, pickChainTrailer } from "@/lib/materialize/per-chain-leader";
import { SpecSchema, type Spec } from "@/lib/spec-schema";
import { DEV_ONLY_BENCH_SLUGS, REMOVED_BENCH_SLUGS } from "@/lib/removed-benches";
import { renderBenchmarkText } from "@/lib/bench-template";
import { liveResults as liveProviderResults } from "@/lib/provider-filters";
import { notServedLabel, notServedOnEveryView } from "@/lib/no-figure-label";
import { notServedReason, priceReading, rankGateReason } from "@/lib/not-served-reason";
import { rankGateLabel } from "@/lib/rank-gate";
import {
  classifyHealth,
  aggregateConfidence,
} from "@/lib/sample-health";

/** Overridable so the worker can run with a different cwd. */
const SPECS_DIR =
  process.env.OCB_SPECS_DIR ?? path.join(process.cwd(), "benchmarks");

/** Camel-cased copy of the spec's optional `chart` block. */
export function chartFromSpec(spec: {
  chart?: {
    min_range?: "24h" | "7d" | "30d";
    default_range?: "24h" | "7d" | "30d" | "90d" | "1y";
    window_label?: string;
    default_panel_by_chain?: Record<string, string>;
    hide_headline_by_chain?: string[];
  };
}): Benchmark["chart"] {
  if (!spec.chart) return undefined;
  return {
    minRange: spec.chart.min_range,
    defaultRange: spec.chart.default_range,
    windowLabel: spec.chart.window_label,
    defaultPanelByChain: spec.chart.default_panel_by_chain,
    hideHeadlineByChain: spec.chart.hide_headline_by_chain,
  };
}

/** Side-effect hooks injected by the caller (site: KV snapshot write;
 *  worker: store publish). Keeps this module free of persistence deps. */
export type LoadHooks = {
  /** Called with the rendered bench after a successful UNFILTERED live
   *  load of a live spec. Not called for filtered variants or drafts. */
  onRendered?: (b: Benchmark) => void;
};

export type BenchmarkFilters = {
  chain?: string;
  region?: string;
  kind?: string;
  venue?: string;
  amount_usd?: string;
  /** Trade-size bucket; injects the `bucket` label like the others. */
  bucket?: string;
  /** Access cohort (public / keyed). Selects providers, injects no label. */
  tier?: string;
};

const FILTER_KEYS = ["chain", "region", "kind", "venue", "amount_usd", "bucket", "tier"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function filterSig(f: BenchmarkFilters): string {
  // Stable ordering, ignore "all" / undefined which mean "no filter".
  const parts: string[] = [];
  for (const k of Object.keys(f).sort()) {
    const v = (f as Record<string, string | undefined>)[k];
    if (v && v !== "all") parts.push(`${k}=${v}`);
  }
  return parts.join("&");
}
export function parseFilterSig(sig: string): BenchmarkFilters {
  const out: BenchmarkFilters = {};
  if (!sig) return out;
  for (const kv of sig.split("&")) {
    const [k, v] = kv.split("=");
    if (k && v && (FILTER_KEYS as readonly string[]).includes(k)) {
      out[k as FilterKey] = v;
    }
  }
  return out;
}
// Module-level memo. Spec YAMLs are immutable for the lifetime of a
// deployment (Vercel lambda) or worker container, but the React cache()
// wrapper around this loader is a no-op inside unstable_cache callbacks
// — so the catalog aggregate was re-reading all spec files once PER
// BENCH, in parallel. At 57 specs that is ~57×57 concurrent opens and
// the lambda dies with EMFILE ("too many open files"), collapsing
// /api/citable and the sitemap to drafts (2026-07-04 incident, first
// triggered by growing the catalog from 45 to 57 specs).
let specsMemo: Promise<Spec[]> | null = null;

export function loadSpecsUncached(): Promise<Spec[]> {
  specsMemo ??= loadSpecsFromDisk().catch((err) => {
    // Never memoize a failure: a transient fs error would otherwise
    // poison every subsequent load for the lambda's lifetime.
    specsMemo = null;
    throw err;
  });
  return specsMemo;
}

async function loadSpecsFromDisk(): Promise<Spec[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(SPECS_DIR)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml")
    );
  } catch {
    return [];
  }
  const parsed = await Promise.all(
    files.map(async (f) => {
      const raw = await fs.readFile(path.join(SPECS_DIR, f), "utf8");
      const result = SpecSchema.safeParse(yaml.load(raw));
      if (!result.success) {
        // CI catches this via `pnpm validate`. At runtime we skip and log.
        console.warn(`[spec] skipping ${f}:`, result.error.message);
        return null;
      }
      return result.data;
    })
  );
  const specs = parsed.filter((s): s is Spec => s !== null);
  // Prod-only gate: staging-pipeline benches never reach the prod
  // catalog, hubs, feeds or citable API. Direct URL hits get a 410
  // from middleware. Staging/preview/dev render everything.
  if (process.env.VERCEL_ENV === "production") {
    return specs.filter((s) => !REMOVED_BENCH_SLUGS.has(s.slug) && !DEV_ONLY_BENCH_SLUGS.has(s.slug));
  }
  return specs;
}

export function buildEditorial(
  spec: Spec,
): Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt"> {
  return {
    slug: spec.slug,
    number: spec.number,
    title: spec.title,
    seoTitle: spec.seo_title,
    seoDescription: spec.seo_description,
    seoIntro: spec.seo_intro,
    disclaimer: spec.disclaimer,
    faq: spec.faq,
    excludedProviders: spec.excluded_providers,
    window: spec.prometheus?.window,
    expectedFreshnessSec: spec.prometheus?.expected_freshness_seconds,
    perChainExplainer: spec.per_chain_explainer,
    subtitle: spec.subtitle,
    category: spec.category,
    status: spec.status,
    editorialStatus: spec.status,
    metric: spec.metric,
    panelMainLabel: spec.panel_main_label,
    panelMainDescription: spec.panel_main_description,
    stackedShare: spec.stacked_share,
    chart: chartFromSpec(spec),
    unit: spec.unit,
    higherIsBetter: spec.higher_is_better,
    rowNoun: spec.row_noun,
    headlineSlice: spec.headline_slice,
    valueKind: specValueKind(spec),
    abstract: spec.abstract,
    methodology: spec.methodology,
    findings: spec.findings,
    source: spec.source,
    dimensions: spec.dimensions,
    dimensionLabels: spec.dimension_labels,
    zeroIsAValue: spec.zero_is_a_value,
    raceLeader: spec.race_leader
      ? { floor: spec.race_leader.floor, sharePanel: spec.race_leader.share_panel }
      : undefined,
    aggregateFilters: spec.aggregate_filters,
    ledgerColumns: spec.ledger_columns,
    ledgerReliability: spec.ledger_reliability,
    providerNotes: spec.provider_notes,
  };
}

// Used by the per-bench cache aggregator when a single bench fully fails
// (cold start + Prom blackout, no previous cache to preserve). Renders a
// draft placeholder so the page still works.
export function draftPlaceholderForSpec(spec: Spec): Benchmark {
  return draftBenchmark(spec, buildEditorial(spec));
}

/** The headline tier of a bench that declares `dimensions.tier`: the
 *  pinned `aggregate_filters.tier`, else the first declared value. */
export function defaultTier(spec: Spec): string | undefined {
  const tiers = spec.dimensions?.tier ?? [];
  if (tiers.length === 0) return undefined;
  return (spec.aggregate_filters as { tier?: string } | undefined)?.tier ?? tiers[0].value;
}

/** Tier a spec provider belongs to (spec.provider.tier, else the first
 *  declared value). Undefined on benches without the dimension. */
export function providerTier(spec: Spec, p: Spec["providers"][number]): string | undefined {
  const tiers = spec.dimensions?.tier ?? [];
  if (tiers.length === 0) return undefined;
  return p.tier ?? tiers[0].value;
}

/** Restrict a tier-dimensioned spec to one cohort. The tier dimension
 *  never touches PromQL: the public and keyed harnesses already emit
 *  disjoint series (the keyed one pins tier="keyed" in every query),
 *  so selecting a cohort is selecting providers. Everything downstream
 *  (augmentation, cell ranks, the {{count}} placeholder, the ledger)
 *  then sees one cohort and ranks it alone. */
export function restrictToTier(spec: Spec, tier: string | undefined): Spec {
  if (!tier || !spec.dimensions?.tier) return spec;
  return {
    ...spec,
    providers: spec.providers.filter((p) => providerTier(spec, p) === tier),
  };
}

/** A tier selection is a cohort switch, not a slice: the "filtered"
 *  semantics (no augmentation of missing providers, no cell ranks) are
 *  for label filters only. */
function labelFilters(f: BenchmarkFilters): BenchmarkFilters {
  const rest: BenchmarkFilters = { ...f };
  delete rest.tier;
  return rest;
}

export async function specToBenchmark(
  fullSpec: Spec,
  options: BenchmarkFilters = {},
  hooks?: LoadHooks,
): Promise<Benchmark> {
  // Merge spec-declared aggregate defaults UNDER the reader's filters:
  // an explicit ?region= / tab selection always wins over the pin. The
  // unfiltered-view semantics below (provider augmentation, "All" copy)
  // key on the reader's filters only, so a pinned aggregate still reads
  // as the bench's headline view rather than a filtered slice.
  const merged: BenchmarkFilters = {
    ...((fullSpec.aggregate_filters ?? {}) as BenchmarkFilters),
    ...options,
  };
  // Tier: select the cohort first, so every step below (including the
  // editorial base, whose dimensions/aggregate pin are unchanged) works
  // on one cohort's providers. A reader-supplied tier wins over the pin
  // and over the first declared value.
  const activeTier = fullSpec.dimensions?.tier
    ? merged.tier ?? defaultTier(fullSpec)
    : undefined;
  const spec = restrictToTier(fullSpec, activeTier);
  const editorial = buildEditorial(spec);

  const activeLabels = activeFilterLabels(labelFilters(merged));
  const isFiltered = Object.keys(activeFilterLabels(labelFilters(options))).length > 0;
  const filteredSpec =
    Object.keys(activeLabels).length > 0
      ? applyDimensionsToSpec(spec, activeLabels)
      : spec;

  const live = await tryLoadLive(filteredSpec, isFiltered);
  if (live) {
    // Mark live entries explicitly so a missing `availability` reads as
    // "unknown" everywhere else in the code. Unresponsive rows keep
    // their "unavailable" marker so no ranking surface counts them.
    for (const r of live.results) {
      if (!r.unresponsive) r.availability = "live";
      if (activeTier) r.tier = activeTier;
    }

    // Augment with spec-declared providers that didn't return data this
    // cycle, but only on the *unfiltered* view. When the reader has
    // applied a dimension filter (e.g. chain=bnb on rpc-capabilities)
    // a no-data result almost always means the provider doesn't cover
    // that dimension at all (rpc-capabilities ships ~15 providers but
    // only 5 of them serve BNB; the other 10 are by-design absent on
    // that tab). Surfacing those as "Currently unavailable" rows would
    // pollute the leaderboard with 10 fake-offline entries and confuse
    // the reader about which providers are actually broken vs which
    // simply don't compete on this chain.
    //
    // On the unfiltered "All" tab we still augment because then a no-data
    // result really does mean "harness lost this provider"; product
    // pages also rely on the augmentation to stay reachable when the
    // upstream is briefly down.
    // A bench whose not-served label holds on every tab lists its missing
    // providers on filtered views too, unranked and with the label, rather
    // than dropping them with no reason (see notServedOnEveryView).
    // A row the spec's rank gate left unranked reads "Provisional"; a bench
    // that knows why says so instead (bench 310: an "at least" price).
    {
      const view = activeFilterLabels(labelFilters(options));
      for (const r of live.results) {
        if (r.unrankedLabel !== "Provisional") continue;
        // The row goes in because the interactive table dashes the success
        // cell for every unranked row (ledger-table.tsx:1175) while the
        // served HTML renders it (static-ledger.tsx:186). A bench whose
        // reason NEEDS its size has to carry it in the label, which both
        // surfaces render.
        r.unrankedLabel = rankGateReason(spec.slug, r.slug, view, r) ?? r.unrankedLabel;
      }
    }
    // Pricing benches: carry the calculator's reading of a two-way price
    // onto the ledger row.
    {
      const view = activeFilterLabels(labelFilters(options));
      for (const r of live.results) {
        const reading = priceReading(spec.slug, r.slug, view);
        if (reading) r.priceReading = reading;
      }
    }
    if (isFiltered && notServedOnEveryView(spec.slug)) {
      const label = notServedLabel(spec.slug);
      const present = new Set(live.results.map((r) => r.slug.toLowerCase()));
      const view = activeFilterLabels(labelFilters(options));
      for (const p of spec.providers) {
        if (!label || present.has(p.slug.toLowerCase())) continue;
        live.results.push({
          name: p.name,
          slug: p.slug,
          tag: p.tag,
          type: p.type,
          layer: p.layer,
          ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
          successRate: 100,
          secondary: p.secondary,
          availability: "live",
          unrankedLabel: notServedReason(spec.slug, p.slug, view) ?? label,
          formula: p.formula,
          endpoint: p.endpoint,
          ...(activeTier ? { tier: activeTier } : {}),
        });
      }
    }
    if (!isFiltered) {
      const liveSlugs = new Set(live.results.map((r) => r.slug.toLowerCase()));
      // On the two RPC cost benches a provider with no figure on the
      // default view sells a chain that view does not ask about (Helius,
      // Syndica, Triton: Solana only). Backfilling them as "unavailable,
      // 0 % success" told /api/stat, the variant API and MCP that three
      // products that lead Solana cells were dead, on a bench that sends no
      // traffic (audit 2026-10-22). They are listed as unranked with the
      // reason instead, the way spec-declared unranked members are.
      const notServed = notServedLabel(spec.slug);
      for (const p of spec.providers) {
        if (liveSlugs.has(p.slug.toLowerCase())) continue;
        if (notServed) {
          live.results.push({
            name: p.name,
            slug: p.slug,
            tag: p.tag,
            type: p.type,
            layer: p.layer,
            ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
            successRate: 100,
            secondary: p.secondary,
            availability: "live",
            unrankedLabel: notServedReason(spec.slug, p.slug, {}) ?? notServed,
            formula: p.formula,
            endpoint: p.endpoint,
            ...(activeTier ? { tier: activeTier } : {}),
          });
          continue;
        }
        live.results.push({
          name: p.name,
          slug: p.slug,
          tag: p.tag,
          type: p.type,
          layer: p.layer,
          ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
          successRate: 0,
          secondary: p.secondary,
          availability: "unavailable",
          formula: p.formula,
          endpoint: p.endpoint,
          ...(activeTier ? { tier: activeTier } : {}),
        });
      }

      // Companion-metric backstop. The augmentation above marks any
      // provider whose headline `p50` query returned nothing as
      // "unavailable". On benches like hl-frontends where the headline
      // metric (effective fee bps) is legitimately empty for a builder
      // that had no fees in the rolling window but still routed real
      // volume, the same builder shows up live on the companion
      // panels (volume, fills/min, last fill age, taker share). Marking
      // it "unavailable" then is misleading: the reader switches to
      // the Volume panel, sees the line, then looks at the table and
      // reads "Currently unavailable" against a row that clearly has
      // data. Reclassify those to "live" so the row renders as a
      // first-class entry; the ledger still sorts it last because
      // ms.p50=0, but it stops claiming the provider is down.
      if (live.metricPanels && live.metricPanels.length > 0) {
        for (const r of live.results) {
          if (r.availability !== "unavailable") continue;
          // Never promote unresponsive rows: their call counters ARE
          // panel-shaped data on some benches, but a 0-2% success rate
          // is exactly the condition the badge exists to surface.
          if (r.unresponsive) continue;
          const slug = r.slug.toLowerCase();
          const hasPanelData = live.metricPanels.some((panel) => {
            const v = panel.values?.[r.slug] ?? panel.values?.[slug];
            if (v != null && Number.isFinite(v)) return true;
            const series =
              panel.seriesByProvider?.[r.slug] ??
              panel.seriesByProvider?.[slug];
            return Array.isArray(series) && series.length > 0;
          });
          if (hasPanelData) r.availability = "live";
        }
      }
    }
    // Spec-declared unranked members (provider.unranked). They carry the
    // label so the ledger lists them in their own block instead of
    // dropping them, and never read as unresponsive: the absence from the
    // order is intended.
    //
    // Outside the !isFiltered block, because "never ranked, never a leader"
    // is a property of the provider and not of the view. It had been swept
    // in with the augmentation of missing providers, which really is
    // unfiltered-only, and so every chain tab lost the labels: bench 304's
    // BSC tab ranked Bebop and LI.FI, an RFQ venue and a relayer, inside
    // the router order the page's own methodology says they are kept out
    // of. They sat last, so no leader was wrong yet.
    //
    // The measured value stays, which is the same call applyFullCoverageScope
    // makes below and for the same reason. This path used to zero the
    // percentiles for every labelled row, on the assumption the label
    // always meant "no value exists" (a perp DEX pre-TGE). Bench 304
    // broke that: CoW, Bebop and LI.FI are measured and merely not
    // comparable to a router, and the zeroing published "0.00 bps" for a
    // venue giving up a hundred. Of the eleven labelled rows on the four
    // specs that shipped the field first, ten return nothing from
    // Prometheus and are dropped upstream before this loop, so the zero
    // reached exactly one: perp-pf-ratio's Paradex, whose adapter the
    // spec itself calls incomplete. That row now asks for the blanking
    // with `unranked_hides_value`.
    const unrankedBySlug = new Map(
      spec.providers
        .filter((p) => p.unranked)
        .map((p) => [
          p.slug.toLowerCase(),
          { label: p.unranked as string, hide: p.unranked_hides_value },
        ]),
    );
    if (unrankedBySlug.size > 0) {
      for (const r of live.results) {
        const entry = unrankedBySlug.get(r.slug.toLowerCase());
        if (!entry) continue;
        r.unrankedLabel = entry.label;
        r.unresponsive = undefined;
        r.availability = "live";
        if (entry.hide) r.ms = { p50: 0, p90: 0, p99: 0, mean: 0 };
      }
    }
    // Per-chain leaders/trailers: computed only on the unfiltered "All"
    // view of benches that declare `dimensions.chain`. Fan out one extra
    // tryLoadLive() per chain value (excluding "all") with the chain
    // label injected via applyDimensionsToSpec, then pick the live
    // leader + trailer for that chain. This powers the
    // `{{best_name:chain:X}}` placeholders + chain-aware OG/badge
    // surfaces. We deliberately don't augment unavailable providers
    // here: for per-chain leader we only care which provider actually
    // reported data on that chain. Failures are tolerated — a chain
    // with no Prom data just doesn't show up in bestPerChain.
    let bestPerChain: Record<string, ProviderResult> | undefined;
    let worstPerChain: Record<string, ProviderResult> | undefined;
    let providersPerChain: Record<string, string[]> | undefined;
    // Per-chain leaders/trailers/presence are computed ONLY on the
    // unfiltered view. Earlier this also ran for filtered variants to
    // populate {{best_name:chain:X}} in the variant's editorial copy,
    // but that quadrupled Prom load per page (3 extra queries × 9
    // pre-fetched variants on benches like aggregator-head-lag). The
    // filtered variants now inherit findings/faq/seoIntro from the
    // aggregate via the page-level fetch in app/benchmarks/[slug]/page.tsx,
    // so per-chain compute on filtered variants is no longer needed.
    // The fan-out also runs on a view filtered by something OTHER than
    // chain when the bench opted into a score_scope. Without it the rule
    // had no per-chain data on the region tabs, so Route kept ranking
    // first on US East and EU West, which is the exact claim #3052 was
    // written to remove. A chain tab needs nothing: it is already one
    // chain, so there is no cross-chain mix to correct. The extra loads
    // are paid only by a bench that asked for the scope.
    const chainFilterActive = Boolean(
      activeFilterLabels(labelFilters(options)).chain,
    );
    const needsChainFanOut =
      !isFiltered || (!!spec.score_scope && !chainFilterActive);
    if (needsChainFanOut && spec.dimensions?.chain && spec.dimensions.chain.length > 0) {
      const chainValues = spec.dimensions.chain
        .map((c) => c.value)
        .filter((v) => v !== "all");
      const perChainEntries = await Promise.all(
        chainValues.map(async (chain) => {
          const chainSpec = applyDimensionsToSpec(spec, { chain });
          const chainLive = await tryLoadLive(chainSpec, true);
          if (!chainLive) {
            return [
              chain,
              undefined,
              undefined,
              [] as string[],
              {} as Record<string, number>,
            ] as const;
          }
          for (const r of chainLive.results) {
            if (!r.unresponsive) r.availability = "live";
          }
          const liveForChain = liveProviderResults(chainLive.results);
          const slugs = liveForChain.map((r) => r.slug);
          // Per-provider value on this chain. Kept (not just the leader)
          // so `score_scope: contested_chains` can rebuild a value from
          // the chains a provider was actually compared on.
          const values: Record<string, number> = {};
          for (const r of liveForChain) values[r.slug.toLowerCase()] = r.ms.p50;
          // Every percentile, not just the median. Rescoring over a basket
          // wrote the p50 mean into p90, p99 and mean alike, so the tail
          // columns became copies of the median: KyberSwap read 220 ms in
          // all four while its measured p99 is 931, and CoW's 4,961 ms
          // Arbitrum tail hid behind 1,658. A desk reads the p99 column
          // precisely because it is not the median.
          const spreads: Record<string, ProviderResult["ms"]> = {};
          for (const r of liveForChain) spreads[r.slug.toLowerCase()] = r.ms;
          if (liveForChain.length === 0) {
            return [chain, undefined, undefined, slugs, values, spreads] as const;
          }
          // Not sorted[0] of everything: a row the board publishes outside
          // its ranking cannot lead a chain, and a shared best value elects
          // nobody. See per-chain-leader.ts for the two live cases.
          return [
            chain,
            pickChainLeader(liveForChain, !!spec.higher_is_better) ?? undefined,
            pickChainTrailer(liveForChain, !!spec.higher_is_better) ?? undefined,
            slugs,
            values,
            spreads,
          ] as const;
        }),
      );
      const bests: Record<string, ProviderResult> = {};
      const worsts: Record<string, ProviderResult> = {};
      const providers: Record<string, string[]> = {};
      const valuesByChain: Record<string, Record<string, number>> = {};
      const spreadsByChain: Record<string, Record<string, ProviderResult["ms"]>> = {};
      for (const [chain, leader, trailer, slugs, values, spreads] of perChainEntries) {
        if (leader) bests[chain] = leader;
        if (trailer) worsts[chain] = trailer;
        if (slugs.length > 0) providers[chain] = slugs;
        valuesByChain[chain] = values;
        spreadsByChain[chain] = spreads ?? {};
      }
      if (Object.keys(bests).length > 0) bestPerChain = bests;
      if (Object.keys(worsts).length > 0) worstPerChain = worsts;
      if (Object.keys(providers).length > 0) providersPerChain = providers;

      if (spec.score_scope === "contested_chains") {
        applyContestedChainScope(live.results, providers, valuesByChain);
      }
      if (spec.score_scope === "full_coverage") {
        const labels: Record<string, string> = {};
        for (const d of fullSpec.dimensions?.chain ?? []) labels[d.value] = d.label;
        applyFullCoverageScope(live.results, providers, labels, spreadsByChain);
      }
    }

    // Other tier cohorts, live rows only, on the headline (unfiltered,
    // default-tier) view of a tier-dimensioned bench: one extra
    // tryLoadLive per other tier with that cohort's providers. The other
    // tiers' own variants inherit the headline editorial through the
    // variant route, so they never need the stash. Powers {{best_name:tier:keyed}} in the
    // public page's copy, the keyed providers' product-page appearances
    // and the /rpc hub keyed view. Never augmented: a missing keyed
    // provider is simply absent from the stash.
    let tierResults: Record<string, ProviderResult[]> | undefined;
    if (!isFiltered && activeTier && activeTier === defaultTier(fullSpec) && fullSpec.dimensions?.tier) {
      const others = fullSpec.dimensions.tier
        .map((t) => t.value)
        .filter((t) => t !== activeTier);
      const entries = await Promise.all(
        others.map(async (t) => {
          const cohort = restrictToTier(fullSpec, t);
          if (cohort.providers.length === 0) return [t, []] as const;
          const cohortSpec =
            Object.keys(activeLabels).length > 0
              ? applyDimensionsToSpec(cohort, activeLabels)
              : cohort;
          const rows = await tryLoadLive(cohortSpec, true);
          if (!rows) return [t, []] as const;
          for (const r of rows.results) {
            if (!r.unresponsive) r.availability = "live";
            r.tier = t;
          }
          return [t, liveProviderResults(rows.results)] as const;
        }),
      );
      const stash = Object.fromEntries(entries.filter(([, rows]) => rows.length > 0));
      if (Object.keys(stash).length > 0) tierResults = stash;
    }

    // Exact per-cell rankings (chain × region) from the spec's single
    // grouped matrix query. Failures are tolerated: badge/product
    // surfaces fall back to the coarser bestPerChain path.
    const cellRankResult = !isFiltered ? await tryLoadCellRanks(spec) : undefined;
    const cellRanks = cellRankResult?.ranks;
    if (cellRankResult?.venuesWithData?.length) {
      live.extras.venuesWithData = cellRankResult.venuesWithData;
    }
    if (cellRankResult?.venuesForChain && Object.keys(cellRankResult.venuesForChain).length > 0) {
      live.extras.venuesForChain = cellRankResult.venuesForChain;
    }

    // Per-provider sample-health classification. When the spec declares
    // expected_n, every live provider gets `dataConfidence` (healthy /
    // low / insufficient) + `sampleHealth` (raw ratio) so the renderer
    // can badge undersized rows and so citable APIs can refuse to crown
    // a leader drawn from a degraded sample. Bench-wide aggregate is
    // the median of the per-provider classifications.
    const expectedN = isFiltered
      ? spec.expected_n_per_tab ?? spec.expected_n
      : spec.expected_n;
    if (expectedN) {
      for (const r of live.results) {
        // Unresponsive rows carry a full probe count (the calls run,
        // they just fail) — classifying them "healthy" would read as a
        // contradiction next to the badge, and aggregateConfidence
        // already skips unavailable rows. Leave them unclassified.
        if (r.unresponsive) continue;
        const h = classifyHealth(r.sampleSize, expectedN);
        if (h) {
          r.dataConfidence = h.confidence;
          r.sampleHealth = h.ratio;
        }
      }
    }
    const agg = expectedN
      ? aggregateConfidence(live.results, expectedN)
      : undefined;

    // Resolve {{p50:slug}} / {{best_name}} / {{count}} etc. placeholders
    // against the freshly loaded numbers so editorial text (findings,
    // seo_intro, faq) never drifts from the displayed data.
    const rendered = renderBenchmarkText({
      ...editorial,
      ...live,
      bestPerChain,
      worstPerChain,
      providersPerChain,
      tierResults,
      cellRanks,
      expectedN,
      dataConfidence: agg?.confidence,
    });
    // Persistence is the caller's concern (site: KV snapshot write,
    // worker: store publish). Only the unfiltered "All" view of a live
    // spec triggers the hook; filtered variants are derived views.
    if (!isFiltered && spec.status === "live") {
      hooks?.onRendered?.(rendered);
    }
    return rendered;
  }
  return draftBenchmark(spec, editorial);
}

/**
 * Rewrite each provider's headline value as its mean over the **contested**
 * chains of the bench: those where at least two providers reported data.
 * A provider with no contested chain is marked unavailable, which takes it
 * out of `liveResults` and therefore out of every ranked surface, while
 * leaving it visible on its own chain tab.
 *
 * Why the value and not the sort order: a cross-chain aggregate is a mix
 * rather than a comparison, so it credits a provider for the chains it
 * happens to be measured on. Narrowing the number keeps one quantity on
 * screen and the ordering follows from it. Ranking on a separate key while
 * still displaying the wide aggregate produced a column that did not
 * descend (80% shown at rank 4, a 74 ms leader shown at rank 3).
 *
 * The residual limitation, stated in the methodology: providers are still
 * averaged over different subsets of the contested chains, since they do
 * not all cover the same ones. It removes the uncontested win, not every
 * difference in chain mix. An unweighted mean is used so a chain counts
 * once regardless of how many samples it carries.
 */
export function applyContestedChainScope(
  results: ProviderResult[],
  providersPerChain: Record<string, string[]>,
  valuesByChain: Record<string, Record<string, number>>,
): void {
  const contested = Object.keys(providersPerChain).filter(
    (chain) => (providersPerChain[chain]?.length ?? 0) >= 2,
  );
  if (contested.length === 0) return;
  for (const r of results) {
    if (r.availability === "unavailable") continue;
    const slug = r.slug.toLowerCase();
    const vals = contested
      .map((chain) => valuesByChain[chain]?.[slug])
      .filter((v): v is number => typeof v === "number" && v > 0);
    if (vals.length === 0) {
      r.availability = "unavailable";
      continue;
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    r.ms = { p50: mean, p90: mean, p99: mean, mean };
  }
}

/**
 * Mark as unranked every provider that does not cover every chain with
 * data, on the unfiltered view of a chain-dimensioned bench.
 *
 * A cross-chain mean compares providers over the ground each happens to
 * stand on. Measured on bench 033: Route quotes Robinhood Chain alone and
 * its all-chains figure was the mean of 3 cells, 215 ms, placing it above
 * KyberSwap's mean of 15 cells over 5 chains, 225 ms. Route does lead
 * Robinhood, and KyberSwap leads the four chains Route never enters, so
 * the headline said the opposite of the evidence under it.
 *
 * This is the rule the cell-rank marginals already apply further down,
 * where the comment calls it Simpson's bias. It was never applied to the
 * ledger or to the product-page rank, which is where the claim is read.
 *
 * Unranked rather than unavailable: the provider answered, and hiding it
 * would lose a real measurement. The label names the coverage so a reader
 * can see why it sits outside the order.
 */
export function applyFullCoverageScope(
  results: ProviderResult[],
  providersPerChain: Record<string, string[]>,
  chainLabels: Record<string, string>,
  spreadsByChain: Record<string, Record<string, ProviderResult["ms"]>>,
): void {
  const chains = Object.keys(providersPerChain).filter(
    (c) => (providersPerChain[c]?.length ?? 0) > 0,
  );
  if (chains.length < 2) return;
  const live = results.filter((r) => r.availability !== "unavailable");
  if (live.length < 2) return;

  // The common basket: chains at least half the live providers cover.
  //
  // Demanding every chain is too blunt. Robinhood joined bench 033 on
  // 2026-10-17 with three providers, and requiring it unranked Mobula,
  // Bebop and CoW as well, each covering four of five and each exactly
  // the comparison a reader wants, leaving two names on the board. A
  // chain that most of the field does not reach is not the ground the
  // comparison stands on; it is a tab of its own.
  // Strictly more than half, not at least half: Robinhood carries exactly
  // three of this bench's six live providers, and "at least" let it back
  // into the basket, which made the whole rule a no-op.
  const common = chains.filter(
    (c) => (providersPerChain[c]?.length ?? 0) * 2 > live.length,
  );
  // Nothing to narrow: every chain is shared, or none is. Either way
  // rescoring would say nothing the headline does not already say.
  if (common.length === 0 || common.length === chains.length) return;

  for (const r of results) {
    if (r.availability === "unavailable" || r.unrankedLabel) continue;
    const slug = r.slug.toLowerCase();
    const inBasket = common.filter((c) =>
      (providersPerChain[c] ?? []).some((s) => s.toLowerCase() === slug),
    );
    if (inBasket.length === 0) {
      // Measured, but on no chain the field shares: it cannot be ranked
      // against them. Name what it does cover so the row still informs.
      const own = chains.filter((c) =>
        (providersPerChain[c] ?? []).some((s) => s.toLowerCase() === slug),
      );
      const label =
        own.length === 1
          ? `${chainLabels[own[0]] ?? own[0]} only`
          : `${own.length} of ${chains.length} chains`;
      r.unrankedLabel = label.length > 20 ? `${own.length}/${chains.length} chains` : label;
      // The measured value stays. Zeroing it, which is what the
      // spec-declared unranked path does, rendered Route as "0 ms" in
      // every percentile column: a wall-clock round trip of zero is
      // impossible and reads either as a broken row or as Route being
      // instant. Nothing needs the zero. citation.ts filters the leader
      // on the label, the ledger pins labelled rows below the ranked
      // field and excludes them from ranks and the field mean, and
      // capital-hub filters on the label too. So the row keeps its real
      // 215 ms and sits outside the order where it belongs.
      continue;
    }
    // Rescore over the basket so the published number is the one the
    // ranking follows, the same rule contested_chains states. Each
    // percentile is averaged over its own per-chain values: writing the
    // p50 mean into all four turned the tail columns into copies of the
    // median and hid a 4,961 ms Arbitrum p99 behind a 1,658 ms figure.
    const cells = inBasket
      .map((c) => spreadsByChain[c]?.[slug])
      .filter((m): m is ProviderResult["ms"] => !!m && m.p50 > 0);
    if (cells.length === 0) continue;
    const avg = (pick: (m: ProviderResult["ms"]) => number | undefined) => {
      const xs = cells
        .map(pick)
        .filter((v): v is number => typeof v === "number" && v > 0);
      return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    };
    const p50 = avg((m) => m.p50);
    r.ms = {
      p50,
      p90: avg((m) => m.p90) || p50,
      p99: avg((m) => m.p99) || p50,
      mean: avg((m) => m.mean) || p50,
    };
  }
}

function activeFilterLabels(opts: BenchmarkFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v && v !== "all") out[k] = v;
  }
  return out;
}


/**
 * Nullify every bucket in `coarse` whose covering time-range overlaps
 * a null bucket in `fine`. Both series are dense right-anchored ("now"
 * = last index), so index i in a series of length N maps to time-ago
 * (N - 1 - i) / (N - 1) of the window. Each contiguous null RUN on the
 * fine grid nulls every coarse bucket its range straddles, so a short
 * outage detected on the 24h grid stays visible as a contiguous band
 * on the 7d and 30d grids (not two neighbouring pills).
 *
 * No-op when either input is missing or too short. Mutates `coarse`.
 * Exported for tests.
 */
export function propagateNullsToCoarser(
  fine: (number | null)[] | null | undefined,
  fineWindowSec: number,
  coarse: (number | null)[] | null | undefined,
  coarseWindowSec: number,
): void {
  if (!fine || !coarse || fine.length < 2 || coarse.length < 2) return;
  if (fineWindowSec <= 0 || coarseWindowSec <= 0) return;
  const fineStep = fineWindowSec / (fine.length - 1);
  const coarseStep = coarseWindowSec / (coarse.length - 1);
  // Right-anchored: last index = now. Map a fine index to the same
  // ABSOLUTE time-ago on the coarse grid (both grids share "now"; the
  // step sizes are what differ, not the reference point). Previous
  // math scaled by the fine window fraction, which shrank a 7 h ago
  // outage down to 40 h ago once projected onto the 7 d grid.
  const toIdxCoarse = (i: number): number => {
    const secondsAgo = (fine.length - 1 - i) * fineStep;
    return (coarse.length - 1) - secondsAgo / coarseStep;
  };
  let runStart: number | null = null;
  const closeRun = (endExclusive: number) => {
    if (runStart == null) return;
    const startX = toIdxCoarse(runStart);
    const endX = toIdxCoarse(endExclusive);
    const lo = Math.max(0, Math.floor(Math.min(startX, endX)));
    const hi = Math.min(coarse.length - 1, Math.ceil(Math.max(startX, endX)));
    for (let k = lo; k <= hi; k++) coarse[k] = null;
    runStart = null;
  };
  for (let i = 0; i < fine.length; i++) {
    if (fine[i] === null) {
      if (runStart == null) runStart = i;
    } else {
      closeRun(i);
    }
  }
  closeRun(fine.length);
}

/**
 * Run the spec's `rank_matrix_query` (one instant vector with a sample per
 * (provider[, chain][, region])) and fold it into full per-cell rankings.
 *
 * Output keys are `<chain>|<region>` with "all" standing in for an
 * undeclared dimension. When BOTH dimensions are declared, marginal cells
 * (`<chain>|all`, `all|<region>`) are derived by averaging a provider's
 * finest-cell values over the collapsed dimension — same semantics as the
 * bench page's unscoped `avg(...)` headline queries.
 *
 * Samples whose provider label doesn't match a spec provider slug, or
 * whose chain/region label isn't a declared dimension value, are dropped:
 * the matrix is unfiltered PromQL, so stray series (retired providers,
 * staging labels) must not leak into rankings.
 */
type CellRankResult = {
  ranks: Record<string, CellRankEntry[]>;
  venuesWithData: string[];
  venuesForChain: Record<string, string[]>;
};

async function tryLoadCellRanks(
  spec: Spec,
): Promise<CellRankResult | undefined> {
  if (!spec.rank_matrix_query) return undefined;
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return undefined;
  try {
    const prom = new Prometheus(url);
    const res = await prom.query(spec.rank_matrix_query);
    if (res.resultType !== "vector") return undefined;

    const slugByLower = new Map(
      spec.providers.map((p) => [p.slug.toLowerCase(), p.slug] as const),
    );
    // Canonical dimension value by lowercase, so a harness emitting
    // `chain="Base"` still maps onto the declared `base` value instead
    // of silently dropping the cell.
    const venueByLower = new Map(
      (spec.dimensions?.venue ?? [])
        .filter((v) => v.value !== "all")
        .map((v) => [v.value.toLowerCase(), v.value] as const),
    );
    const venuesWithDataSet = new Set<string>();
    const venuesForChainMap = new Map<string, Set<string>>();
    const chainByLower = new Map(
      (spec.dimensions?.chain ?? [])
        .filter((c) => c.value !== "all")
        .map((c) => [c.value.toLowerCase(), c.value] as const),
    );
    const regionByLower = new Map(
      (spec.dimensions?.region ?? [])
        .filter((r) => r.value !== "all")
        .map((r) => [r.value.toLowerCase(), r.value] as const),
    );

    // key → provider slug → samples (averaged if the grouping left
    // residual label splits, e.g. multiple replicas per region).
    const acc = new Map<string, Map<string, number[]>>();
    for (const sample of res.result) {
      const slug = slugByLower.get((sample.metric.provider ?? "").toLowerCase());
      if (!slug) continue;
      const chain =
        chainByLower.size > 0
          ? chainByLower.get((sample.metric.chain ?? "").toLowerCase())
          : undefined;
      const region =
        regionByLower.size > 0
          ? regionByLower.get((sample.metric.region ?? "").toLowerCase())
          : undefined;
      if (chainByLower.size > 0 && !chain) continue;
      if (regionByLower.size > 0 && !region) continue;
      const v = Number(sample.value[1]);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (venueByLower.size > 0 && sample.metric.venue) {
        const venue = venueByLower.get(sample.metric.venue.toLowerCase());
        if (venue) {
          venuesWithDataSet.add(venue);
          if (chain) {
            const set = venuesForChainMap.get(chain) ?? new Set<string>();
            set.add(venue);
            venuesForChainMap.set(chain, set);
          }
        }
      }
      const key = `${chain ?? "all"}|${region ?? "all"}`;
      const cell = acc.get(key) ?? new Map<string, number[]>();
      const vals = cell.get(slug) ?? [];
      vals.push(v);
      cell.set(slug, vals);
      acc.set(key, cell);
    }
    if (acc.size === 0) return undefined;

    const mean = (vals: number[]) =>
      vals.reduce((a, b) => a + b, 0) / vals.length;
    const sortCell = (cell: Map<string, number[]>): CellRankEntry[] =>
      [...cell.entries()]
        .map(([slug, vals]) => ({ slug, p50: mean(vals) }))
        .sort((a, b) =>
          spec.higher_is_better ? b.p50 - a.p50 : a.p50 - b.p50,
        );

    const out: Record<string, CellRankEntry[]> = {};
    for (const [key, cell] of acc) out[key] = sortCell(cell);

    // Marginals, only when both dimensions exist in the finest cells.
    // A provider only enters a marginal if it covers EVERY cell of the
    // collapsed dimension that exists for that row/column. Without this,
    // a provider measured only from its fastest region wins the
    // `<chain>|all` average by omission (Simpson's bias), and the badge
    // for "leads chain X" disagrees with the per-cell wins that earned it.
    if (chainByLower.size > 0 && regionByLower.size > 0) {
      const regionsOfChain = new Map<string, Set<string>>();
      const chainsOfRegion = new Map<string, Set<string>>();
      for (const key of acc.keys()) {
        const [chain, region] = key.split("|");
        (regionsOfChain.get(chain) ?? regionsOfChain.set(chain, new Set()).get(chain)!).add(region);
        (chainsOfRegion.get(region) ?? chainsOfRegion.set(region, new Set()).get(region)!).add(chain);
      }
      const marginalFor = (
        groups: Map<string, Set<string>>,
        keyOf: (group: string, member: string) => string,
        mKeyOf: (group: string) => string,
      ) => {
        for (const [group, members] of groups) {
          const cell = new Map<string, number[]>();
          // Providers present in every member cell of the group.
          let eligible: Set<string> | undefined;
          for (const member of members) {
            const slugs = new Set(acc.get(keyOf(group, member))?.keys() ?? []);
            eligible = eligible
              ? new Set([...eligible].filter((s) => slugs.has(s)))
              : slugs;
          }
          for (const slug of eligible ?? []) {
            const vals: number[] = [];
            for (const member of members) {
              const v = acc.get(keyOf(group, member))?.get(slug);
              if (v) vals.push(mean(v));
            }
            if (vals.length > 0) cell.set(slug, [mean(vals)]);
          }
          if (cell.size > 0) out[mKeyOf(group)] = sortCell(cell);
        }
      };
      marginalFor(
        regionsOfChain,
        (chain, region) => `${chain}|${region}`,
        (chain) => `${chain}|all`,
      );
      marginalFor(
        chainsOfRegion,
        (region, chain) => `${chain}|${region}`,
        (region) => `all|${region}`,
      );
    }
    const venuesForChain: Record<string, string[]> = {};
    for (const [c, set] of venuesForChainMap) venuesForChain[c] = [...set];
    return { ranks: out, venuesWithData: [...venuesWithDataSet], venuesForChain };
  } catch (e) {
    console.warn(
      `cellRanks skip: ${spec.slug} matrix query failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/** Inject every active `<label>="<value>"` into every PromQL label selector
 * across the spec's provider queries (including per-region subqueries).
 * Skips selectors that already filter by a given label. */
function applyDimensionsToSpec(spec: Spec, labels: Record<string, string>): Spec {
  const inject = (q: string | undefined) => (q ? injectLabels(q, labels) : q);
  return {
    ...spec,
    // Panels declare a bare metric name (or metric{sel}); normalize to the
    // braced form so dimension labels (chain=..., region=...) reach them
    // like every provider query. Without this a panel on a chain-dimensioned
    // bench silently mixes every chain's series.
    metric_panels: spec.metric_panels?.map((panel) => ({
      ...panel,
      metric: panelMetricQuery(panel, labels),
    })),
    providers: spec.providers.map((p) => ({
      ...p,
      queries: p.queries
        ? {
            ...p.queries,
            p50: inject(p.queries.p50),
            p90: inject(p.queries.p90),
            p95: inject(p.queries.p95),
            p99: inject(p.queries.p99),
            mean: inject(p.queries.mean),
            success: inject(p.queries.success),
            sample_size: inject(p.queries.sample_size),
            series: inject(p.queries.series),
            ranked: inject(p.queries.ranked),
            live_activity: inject(p.queries.live_activity),
            regions: p.queries.regions?.map((r) => ({
              ...r,
              p50: inject(r.p50),
              series: inject(r.series),
            })),
          }
        : p.queries,
    })),
    prometheus: spec.prometheus
      ? { ...spec.prometheus, probe_ok: inject(spec.prometheus.probe_ok) }
      : spec.prometheus,
  };
}

/** The dimension labels a reader's filters select, ready for injectLabels.
 *
 * `tier` is excluded because it picks the cohort rather than narrowing a
 * series, and an `all` value is not a filter. Exported so a caller holding
 * loose filter strings can build the same label set the loader uses.
 */
export function dimensionLabels(f: BenchmarkFilters): Record<string, string> {
  return activeFilterLabels(labelFilters(f));
}

/** The PromQL a metric panel runs under the reader's active filters.
 *
 * A panel declares a bare metric name or `metric{sel}`; normalise to the
 * braced form so the dimension labels reach it like every provider query.
 * Without this, a panel on a chain-dimensioned bench silently pools every
 * chain into one line.
 *
 * Exported because TWO paths need this exact string and had drifted. The
 * loader builds panel values through applyDimensionsToSpec, but the 7d and
 * 30d panel SERIES are stripped from both the cache form and the snapshot on
 * purpose (slimBenchmarkForCache, toSnapshot) and refetched by
 * /api/series/[slug]?panel=..., which rebuilds them from the raw spec. That
 * route injected only the provider selector, so from the day panels got a
 * chart, every chain tab of bench 001's "First to report" view published the
 * same cross-chain average, while the head-lag view beside it moved per chain
 * because it goes through specToBenchmark. Lucas spotted it on 2026-10-29.
 *
 * A panel may also declare dimensions its metric does not carry: appending one
 * matches nothing and empties the panel in silence, which is how bench 282
 * shipped a "Billing units per request" chart blank on 71 of 75 views. Hence
 * ignore_dimensions, honoured here so both callers honour it.
 */
export function panelMetricQuery(
  panel: { metric: string; ignore_dimensions?: string[] },
  labels: Record<string, string>,
): string {
  const ignored = new Set(panel.ignore_dimensions ?? []);
  const panelLabels = ignored.size
    ? Object.fromEntries(Object.entries(labels).filter(([k]) => !ignored.has(k)))
    : labels;
  return injectLabels(
    panel.metric.includes("{") ? panel.metric : `${panel.metric}{}`,
    panelLabels,
  );
}

export function injectLabels(query: string, labels: Record<string, string>): string {
  return query.replace(/\{([^}]*)\}/g, (_, inside: string) => {
    const additions: string[] = [];
    for (const [k, v] of Object.entries(labels)) {
      // A selector pinned to the dimension's `all` value is the
      // unfiltered form of a bench whose harness publishes a pooled
      // series next to the per-value ones (terminal-fill-quality:
      // `chain="all"` is the product over every chain); a filter
      // replaces it instead of adding a second, contradictory matcher.
      const pinnedAll = new RegExp(`\\b${escapeRe(k)}\\s*=\\s*"all"`);
      if (pinnedAll.test(inside)) {
        inside = inside.replace(pinnedAll, `${k}="${escapePromLabelValue(v)}"`);
        continue;
      }
      const present = new RegExp(`\\b${escapeRe(k)}\\s*=`).test(inside);
      if (!present) additions.push(`${k}="${escapePromLabelValue(v)}"`);
    }
    if (additions.length === 0) return `{${inside}}`;
    const trimmed = inside.trim();
    if (trimmed === "") return `{${additions.join(",")}}`;
    return `{${inside.replace(/\s*$/, "")},${additions.join(",")}}`;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** PromQL label values are double-quoted strings. Escape backslash and
 *  double-quote so a URL-supplied filter value can never break out of the
 *  selector and inject extra label matchers. Newlines stripped for safety. */
function escapePromLabelValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, "");
}

/** Success-rate ceiling (in percent) under which a latency-less cohort
 *  member is classified "unresponsive" rather than transiently
 *  unreadable. Latency percentiles come from the same probes as OK
 *  results (the harness only records latency for successful calls), so
 *  any real success share implies the latency series exists — a null
 *  percentile next to a healthy success rate is a transient Prom read
 *  failure, not a dead endpoint, and must not be badged. */
const UNRESPONSIVE_MAX_SUCCESS_PCT = 5;

/**
 * Build the unranked "unresponsive" entry for a spec-declared provider
 * whose latency percentiles returned nothing this cycle. Returns null
 * when the provider wasn't provably probed in the current view (no
 * success sample AND no call-count sample), which keeps the behavior
 * scoped to specs that declare reliability queries (the RPC family):
 * benches without `success` / `sample_size` queries never produce these
 * rows, and chain/region variants only flag providers whose counters
 * actually exist on that slice (a provider that simply doesn't cover
 * the filtered chain stays absent, not fake-offline).
 *
 * Exported for unit tests.
 */
export function unresponsiveResult(
  p: Spec["providers"][number],
  probe: { success: number | null; sampleSize: number | null },
): ProviderResult | null {
  const probed =
    (probe.sampleSize != null && probe.sampleSize > 0) || probe.success != null;
  if (!probed) return null;
  // Same ratio-vs-percent normalization as the live path. A missing
  // success sample with live call counters means the ok-rate series is
  // entirely absent (zero successful probes in the window) → 0%.
  const successPct =
    probe.success != null
      ? probe.success > 1
        ? probe.success
        : probe.success * 100
      : 0;
  if (successPct >= UNRESPONSIVE_MAX_SUCCESS_PCT) return null;
  return {
    name: p.name,
    slug: p.slug,
    tag: p.tag,
    type: p.type,
    layer: p.layer,
    ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
    successRate: successPct,
    sampleSize: probe.sampleSize ?? undefined,
    secondary: p.secondary,
    availability: "unavailable",
    unresponsive: true,
    formula: p.formula,
    endpoint: p.endpoint,
  };
}

async function tryLoadLive(
  spec: Spec,
  isFiltered = false
): Promise<Pick<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt" | "metricPanels"> | null> {
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return null;
  const prom = new Prometheus(url);
  const winSec = parseDurationSec(spec.prometheus?.window ?? "24h") ?? 86_400;

  try {
    const liveResults: ProviderResult[] = [];
    const series24h: Record<string, (number | null)[]> = {};
    const series7d: Record<string, (number | null)[]> = {};
    const series30d: Record<string, (number | null)[]> = {};
    const seriesByRegion24h: Record<string, Record<string, (number | null)[]>> = {};
    const seriesByRegion7d: Record<string, Record<string, (number | null)[]>> = {};
    const seriesByRegion30d: Record<string, Record<string, (number | null)[]>> = {};
    const regions: Record<string, { region: string; p50: number }[]> = {};
    let totalSamples = 0;
    const sevenDaysSec = 7 * 86_400;
    const thirtyDaysSec = 30 * 86_400;

    // Bench-level "is our end fine" gate. Fetched once per sweep; feeds
    // every provider's liveStatus verdict below so a broken harness / Prom
    // scrape can't fake-flag every provider as down at once. Absent when
    // the spec doesn't declare probe_ok — in which case we trust each
    // provider's live_activity unconditionally.
    const probeOkQuery = spec.prometheus?.probe_ok;
    const probeOk = probeOkQuery
      ? await prom.scalar(probeOkQuery)
      : null;
    // Interpret: >0 or null-when-not-declared → trust per-provider verdicts.
    // Explicit 0 (or NaN) → the probe itself is down; suppress all badges.
    const trustLiveVerdicts = !probeOkQuery || (probeOk != null && probeOk > 0);

    for (const p of spec.providers) {
      const q = p.queries;
      if (!q) return null;

      let [p50, p90, p99] = await Promise.all([
        q.p50 ? prom.scalar(q.p50) : Promise.resolve(null),
        q.p90 ? prom.scalar(q.p90) : Promise.resolve(null),
        q.p99 ? prom.scalar(q.p99) : Promise.resolve(null),
      ]);
      // p95 rides with the optional batch on purpose: no retry and no
      // skip-on-null, so a bench that declares it badly loses a column and
      // not its providers.
      const [p95, mean, success, sampleSize, slotP50, slotP99, liveActivity, firstRankGate] = await Promise.all([
        q.p95 ? prom.scalar(q.p95) : Promise.resolve(null),
        q.mean ? prom.scalar(q.mean) : Promise.resolve(null),
        q.success ? prom.scalar(q.success) : Promise.resolve(null),
        q.sample_size ? prom.scalar(q.sample_size) : Promise.resolve(null),
        q.slot_p50 ? prom.scalar(q.slot_p50) : Promise.resolve(null),
        q.slot_p99 ? prom.scalar(q.slot_p99) : Promise.resolve(null),
        q.live_activity ? prom.scalar(q.live_activity) : Promise.resolve(null),
        q.ranked ? prom.scalar(q.ranked) : Promise.resolve(null),
      ]);
      // The rank gate gets the same one retry as the percentiles, and for a
      // stronger reason: it decides whether a row may LEAD. `prom.scalar`
      // returns null for an error and for an empty result alike, so one
      // timed-out query used to promote the row it was meant to hold back.
      // Retry first, so a transient null does not gate an eligible provider,
      // then fail closed below, so a persistent one cannot crown an
      // ineligible one.
      const rankGate =
        q.ranked && firstRankGate == null ? await prom.scalar(q.ranked) : firstRankGate;

      // One retry on the load-bearing percentiles. A null here is either
      // "provider has no data" (retry returns null again, harmless) or a
      // transient Prom timeout under burst load (retry usually lands now
      // that the concurrency cap has drained the burst). This is the
      // difference between a provider flickering off the leaderboard for
      // 60s and a stable board. Unfiltered view only: on chain/region
      // tabs a null usually means the provider structurally isn't on
      // that slice, and retrying every absent provider on every variant
      // would triple the query bill for nothing.
      if (!isFiltered && (p50 == null || p90 == null || p99 == null) && q.p50 && q.p90 && q.p99) {
        const [r50, r90, r99] = await Promise.all([
          p50 == null ? prom.scalar(q.p50) : Promise.resolve(p50),
          p90 == null ? prom.scalar(q.p90) : Promise.resolve(p90),
          p99 == null ? prom.scalar(q.p99) : Promise.resolve(p99),
        ]);
        p50 = r50;
        p90 = r90;
        p99 = r99;
      }

      // If a provider has no data for the current filter (e.g. Jupiter on
      // BNB Chain when Jupiter is Solana-only), skip it instead of failing
      // the whole benchmark. The page still renders with the providers
      // that do have numbers.
      //
      // Log which percentile came back null so transient AWAITING events
      // are diagnosable. The Prom-client only logs explicit errors (400,
      // timeout), not legitimately empty results, which is the most
      // common AWAITING trigger. Logged at warn level only on the
      // unfiltered "All" view to avoid spamming logs on filtered views
      // where a missing provider is expected behavior.
      // For gauge-only benches (e.g. validator yield) p90/p99 are not
      // defined in the spec. Fall back to p50 so the provider isn't skipped.
      if (p90 == null && !q.p90) p90 = p50;
      if (p99 == null && !q.p99) p99 = p50;

      if (p50 == null || p90 == null || p99 == null) {
        // Unresponsive cohort member: the latency series is gone from
        // the window (failed probes record no latency, so a fully dead
        // endpoint's percentiles go Prom-stale within 24h) but the call
        // counters still prove probing continues. Keep the provider on
        // the board as an unranked "unresponsive" row carrying its
        // success rate + sample size instead of silently vanishing.
        // Applies to filtered (region) variants too — the injected
        // labels make the counters view-scoped, so a provider dead in
        // only one region is flagged on that region's tab while ranking
        // normally everywhere it still answers.
        const unresponsive = unresponsiveResult(p, { success, sampleSize });
        if (unresponsive) {
          liveResults.push(unresponsive);
          if (sampleSize) totalSamples += sampleSize;
          continue;
        }
        if (!isFiltered && spec.status === "live") {
          const missing = [
            p50 == null ? "p50" : null,
            p90 == null ? "p90" : null,
            p99 == null ? "p99" : null,
          ]
            .filter(Boolean)
            .join(",");
          console.warn(
            `bench skip: ${spec.slug}/${p.slug} missing ${missing}`,
          );
        }
        continue;
      }

      // liveStatus: only computed when the spec declares live_activity.
      // "unknown" wins whenever we can't tell (probe_ok says our side is
      // broken, or the activity query returned no sample) — never falls
      // through to "down" on ambiguous data, since a false red pill on
      // a live provider is worse than a missing pill on a real outage.
      let liveStatus: "healthy" | "down" | "unknown" | undefined;
      if (q.live_activity) {
        if (!trustLiveVerdicts || liveActivity == null) {
          liveStatus = "unknown";
        } else if (liveActivity > 0) {
          liveStatus = "healthy";
        } else {
          liveStatus = "down";
        }
      }

      liveResults.push({
        name: p.name,
        slug: p.slug,
        tag: p.tag,
        type: p.type,
        layer: p.layer,
        // Explicit: a row that reached this point has real aggregates,
        // whatever their sign. liveResults() keeps such a row on a finite
        // p50, so a signed metric (slippage vs quote: a bridge that beats
        // its quote is negative) is not dropped by the legacy `p50 > 0`
        // guard, which only applies to rows without the flag.
        availability: "live",
        ms: {
          p50,
          p90,
          p99,
          mean: mean ?? p50,
          ...(p95 != null && Number.isFinite(p95) ? { p95 } : {}),
        },
        slots:
          slotP50 != null && slotP99 != null
            ? { p50: slotP50, p99: slotP99 }
            : undefined,
        successRate: success != null ? (success > 1 ? success : success * 100) : 100,
        sampleSize: sampleSize ?? undefined,
        // Published either way (its figures stand); listed as provisional
        // below the ranked rows, never a leader. The three outcomes and why
        // a null is one of them are in rankGateLabel.
        unrankedLabel: rankGateLabel(q.ranked, rankGate),
        secondary: p.secondary,
        query: q.p50,
        formula: p.formula,
    endpoint: p.endpoint,
        liveStatus,
      });

      if (q.series) {
        const [s24, s7, s30] = await Promise.all([
          prom.series(q.series, winSec, 72),
          prom.series(q.series, sevenDaysSec, 84),
          prom.series(q.series, thirtyDaysSec, 60),
        ]);
        // Propagate short outages captured on the fine 24h grid up to
        // the coarser 7d/30d grids. Only when the bench opted in via
        // `live_activity` — other benches carry natural nulls (sparse
        // scrapes, backfill edges) that shouldn't fire a "DATA MISSING"
        // pill on the chart.
        if (q.live_activity && s24 && s24.length > 0) {
          propagateNullsToCoarser(s24, winSec, s7, sevenDaysSec);
          propagateNullsToCoarser(s24, winSec, s30, thirtyDaysSec);
        }
        if (s24 && s24.length > 0) series24h[p.slug] = s24;
        if (s7 && s7.length > 0) series7d[p.slug] = s7;
        if (s30 && s30.length > 0) series30d[p.slug] = s30;
      }

      if (q.regions && q.regions.length > 0) {
        const points = await Promise.all(
          q.regions.map(async (r) => {
            const [p50Val, regionSeries24, regionSeries7, regionSeries30] = await Promise.all([
              r.p50 ? prom.scalar(r.p50) : Promise.resolve(p50),
              r.series ? prom.series(r.series, winSec, 72) : Promise.resolve(null),
              r.series ? prom.series(r.series, sevenDaysSec, 84) : Promise.resolve(null),
              r.series ? prom.series(r.series, thirtyDaysSec, 60) : Promise.resolve(null),
            ]);
            return {
              region: r.region,
              p50: p50Val ?? p50,
              series24: regionSeries24,
              series7: regionSeries7,
              series30: regionSeries30,
            };
          })
        );
        regions[p.slug] = points.map(({ region: rg, p50: v }) => ({ region: rg, p50: v }));
        for (const pt of points) {
          // Same short-outage propagation as the global series above.
          if (q.live_activity && pt.series24 && pt.series24.length > 0) {
            propagateNullsToCoarser(pt.series24, winSec, pt.series7, sevenDaysSec);
            propagateNullsToCoarser(pt.series24, winSec, pt.series30, thirtyDaysSec);
          }
          if (pt.series24 && pt.series24.length > 0) {
            (seriesByRegion24h[p.slug] ??= {})[pt.region] = pt.series24;
          }
          if (pt.series7 && pt.series7.length > 0) {
            (seriesByRegion7d[p.slug] ??= {})[pt.region] = pt.series7;
          }
          if (pt.series30 && pt.series30.length > 0) {
            (seriesByRegion30d[p.slug] ??= {})[pt.region] = pt.series30;
          }
        }
      }

      if (sampleSize) totalSamples += sampleSize;
    }

    // No live numbers from anyone (every provider was skipped) → draft.
    // Unresponsive rows don't count: a board made ONLY of dead providers
    // has no ranking to publish, and letting them satisfy the check
    // would also let them satisfy the quorum guard below during a Prom
    // brownout (counters often survive a partial outage that kills the
    // heavier percentile queries).
    const rankedCount = liveResults.filter((r) => !r.unresponsive).length;
    if (rankedCount === 0) {
      // On a filtered view this is a real state, not a failed cycle: a
      // chain tab whose providers all fell under the floor published
      // nothing on that chain in the window. Returning null here pins the
      // tab to its last render with no expiry, which is how the Arc tab
      // served a 4.5 hour old page carrying a 5,045 bps app fee under
      // GMGN and Maestro after its legs were purged. An empty result lets
      // the page say so. The unfiltered guard below, and the quorum guard
      // after it, are the ones that protect against a Prom brownout.
      if (isFiltered) {
        return { results: [], extras: { series24h: {}, regions: {} }, sampleSize: 0, lastRunAt: new Date().toISOString(), metricPanels: [] };
      }
      return null;
    }

    // Quorum guard. Providers whose p50/p90/p99 come back null are
    // silently skipped above, which is correct for a single flaky source
    // but catastrophic under a Prom brownout: 14 of 15 providers timing
    // out still yielded a "live" render with one bar on the leaderboard,
    // which then got cached for 60s AND overwrote the KV snapshot with
    // the degraded set. Treat a sub-quorum unfiltered render as a failed
    // cycle instead: returning null makes the live-spec path throw, so
    // unstable_cache keeps the last good render (or falls back to the KV
    // snapshot on cold start). Filtered views are exempt — a chain tab
    // legitimately has fewer providers than the spec declares.
    if (!isFiltered) {
      const declared = spec.providers.filter((p) => p.queries).length;
      // Floor at 3 so a bench whose field is legitimately decimated (most
      // declared providers dead for days) can still go live with its
      // survivors instead of drafting forever once the KV snapshot ages
      // out. 3 is still enough to make a leaderboard meaningful, and the
      // brownout scenario this guards against (1-2 stragglers passing
      // while the rest time out) stays caught.
      const quorum = Math.min(Math.ceil(declared / 2), 3);
      if (rankedCount < quorum) {
        console.warn(
          `bench quorum fail: ${spec.slug} live=${rankedCount}/${declared} → keeping previous render`,
        );
        return null;
      }
    }

    // Optional companion metric panels. Each panel declares one Prometheus
    // metric; we query it per provider (`<metric>{<label_key>="<slug>"}`)
    // and store the scalar values. Providers with no data for that metric
    // are omitted from the values map (rendered as "no data" by the UI).
    const metricPanels: MetricPanel[] = [];
    for (const panel of spec.metric_panels ?? []) {
      const values: Record<string, number> = {};
      const seriesByProvider: Record<string, (number | null)[]> = {};
      const seriesByProvider7d: Record<string, (number | null)[]> = {};
      const seriesByProvider30d: Record<string, (number | null)[]> = {};
      await Promise.all(
        spec.providers.map(async (p) => {
          const sel = `${panel.label_key}="${escapePromLabelValue(p.slug)}"`;
          const q = panel.metric.includes("{")
            ? panel.metric.replace("{", `{${sel},`)
            : `${panel.metric}{${sel}}`;
          const [v, s24, s7, s30] = await Promise.all([
            prom.scalar(q),
            prom.series(q, winSec, 72),
            prom.series(q, sevenDaysSec, 84),
            prom.series(q, thirtyDaysSec, 60),
          ]);
          if (v != null && Number.isFinite(v)) values[p.slug] = v;
          if (s24 && s24.length > 0) seriesByProvider[p.slug] = s24;
          if (s7 && s7.length > 0) seriesByProvider7d[p.slug] = s7;
          if (s30 && s30.length > 0) seriesByProvider30d[p.slug] = s30;
        })
      );
      metricPanels.push({
        id: panel.id,
        label: panel.label,
        description: panel.description,
        metric: panel.metric,
        unit: panel.unit,
        higherIsBetter: panel.higher_is_better,
        tab: panel.tab,
        carry: panel.carry,
        values,
        seriesByProvider,
        seriesByProvider7d:
          Object.keys(seriesByProvider7d).length > 0 ? seriesByProvider7d : undefined,
        seriesByProvider30d:
          Object.keys(seriesByProvider30d).length > 0 ? seriesByProvider30d : undefined,
      });
    }

    // Archive depth augmentation for `-rpc` benches (bench cluster
    // 044+). Reads `rpc_archive_depth_supported{chain="<slug>"}` from
    // Prom (one instant query, no per-provider fan-out), aggregates
    // "supported if ANY region reports 1", and attaches the ascending
    // list of supported block depths to each provider row so the /rpc
    // hub can render an archive column without a second Prom trip.
    // Silent no-op when the query returns empty (chains where the
    // archive probe is skipped: Solana / Substrate) or when the spec
    // isn't a -rpc bench.
    if (spec.slug.endsWith("-rpc")) {
      try {
        const chainForArchive = spec.slug.replace(/-rpc$/, "");
        const archiveQuery = `max by(provider, depth)(rpc_archive_depth_supported{chain="${chainForArchive}"} == 1)`;
        const res = await prom.query(archiveQuery);
        if (res.resultType === "vector") {
          const byProvider = new Map<string, number[]>();
          for (const row of res.result) {
            const provider = row.metric.provider;
            const depthStr = row.metric.depth;
            if (!provider || !depthStr) continue;
            const d = Number(depthStr);
            if (!Number.isFinite(d) || d <= 0) continue;
            const arr = byProvider.get(provider) ?? [];
            if (!arr.includes(d)) arr.push(d);
            byProvider.set(provider, arr);
          }
          for (const r of liveResults) {
            const supported = byProvider.get(r.slug);
            if (supported && supported.length > 0) {
              supported.sort((a, b) => a - b);
              r.archiveDepth = { supportedBlocks: supported };
            }
          }
        }
      } catch (e) {
        // archive is a nice-to-have; a failure here must never
        // collapse the bench. Log and continue.
        console.warn(
          `[load/${spec.slug}] archive-depth augmentation failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    // Derive lastRunAt from the actual Prom data freshness. We probe the
    // first provider that has a p50 query and ask Prom for the age of
    // its underlying metric. This is consistent across pages (Prom is the
    // single source of truth) and reflects real data freshness instead of
    // ISR cache age. Falls back to `now` only when extraction fails.
    //
    // Benches reading ocb:* recorded series MUST declare
    // prometheus.freshness_metric (the raw harness metric): a recording
    // rule keeps emitting fresh samples from its 24h window for a full
    // day after the harness dies, so probing the recorded series would
    // mask the outage.
    let lastRunAt = new Date().toISOString();
    const freshnessMetric = spec.prometheus?.freshness_metric;
    const freshnessTsMetric = spec.prometheus?.freshness_timestamp_metric;
    if (freshnessTsMetric) {
      // Value = unix time of the last run (bridge-execution-latency:
      // executions are pulses, an instant query on them is empty between
      // runs and used to fall back to "now", so a dead harness read as
      // "updated 4 min ago" forever).
      // Ask Prometheus for the AGE, not the timestamp: prom.scalar keeps
      // 6 significant digits, which rounds a unix time to the nearest
      // ~1000 s (18:36:50 came back as 17:46:40 on 2026-09-19).
      const ageSec = await prom.scalar(`time() - max(${freshnessTsMetric})`);
      if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0 && ageSec < 10 * 365 * 86_400) {
        lastRunAt = new Date(Date.now() - Math.floor(ageSec * 1000)).toISOString();
      } else {
        // No run recorded at all: say so rather than pretending.
        lastRunAt = new Date(0).toISOString();
      }
    } else if (freshnessMetric) {
      const ageSec = await prom.dataAgeSec(freshnessMetric);
      if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0) {
        lastRunAt = new Date(Date.now() - Math.floor(ageSec * 1000)).toISOString();
      }
    } else {
      for (const p of spec.providers) {
        const q = p.queries?.p50;
        if (!q) continue;
        const ageSec = await prom.dataAgeSec(q);
        if (ageSec != null && Number.isFinite(ageSec) && ageSec >= 0) {
          lastRunAt = new Date(Date.now() - Math.floor(ageSec * 1000)).toISOString();
          break;
        }
      }
    }

    return {
      results: liveResults,
      extras: {
        series24h,
        series7d: Object.keys(series7d).length > 0 ? series7d : undefined,
        series30d: Object.keys(series30d).length > 0 ? series30d : undefined,
        seriesByRegion24h:
          Object.keys(seriesByRegion24h).length > 0 ? seriesByRegion24h : undefined,
        seriesByRegion7d:
          Object.keys(seriesByRegion7d).length > 0 ? seriesByRegion7d : undefined,
        seriesByRegion30d:
          Object.keys(seriesByRegion30d).length > 0 ? seriesByRegion30d : undefined,
        regions: regions as Benchmark["extras"]["regions"],
      },
      metricPanels: metricPanels.length > 0 ? metricPanels : undefined,
      sampleSize: totalSamples,
      lastRunAt,
    };
  } catch {
    return null;
  }
}

function draftBenchmark(
  spec: Spec,
  editorial: Omit<Benchmark, "results" | "extras" | "sampleSize" | "lastRunAt">
): Benchmark {
  // Render the page even when Prometheus has no data yet. the editorial
  // metadata is still useful, and the results section shows "awaiting first
  // run" so readers know what's happening.
  const results: ProviderResult[] = spec.providers.map((p) => ({
    name: p.name,
    slug: p.slug,
    tag: p.tag,
    type: p.type,
    layer: p.layer,
    ms: { p50: 0, p90: 0, p99: 0, mean: 0 },
    successRate: 0,
    secondary: p.secondary,
    formula: p.formula,
    endpoint: p.endpoint,
  }));
  return {
    ...editorial,
    status: "draft",
    results,
    extras: { series24h: {}, regions: {} },
    sampleSize: 0,
    lastRunAt: new Date().toISOString(),
  };
}

function parseDurationSec(d: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(d.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1, m: 60, h: 3600, d: 86_400 }[unit as "s" | "m" | "h" | "d"];
}

/**
 * Lookup helper for the per-chain leader stash. Returns the ProviderResult
 * that leads on `chain` (e.g. "solana"), or undefined when the bench
 * doesn't declare chain dimensions, when the chain isn't in the spec, or
 * when no live data was collected for that chain this cycle.
 *
 * Consumed by the chain-aware template placeholders (bench-template.ts),
 * the chain-aware OG image / badge endpoints (SEO + API surfaces), and
 * the products pages that want to call out a chain-specific winner
 * instead of the biased unfiltered aggregate.
 */
export function bestForChain(
  b: Benchmark,
  chain: string,
): ProviderResult | undefined {
  return b.bestPerChain?.[chain];
}
