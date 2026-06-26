/**
 * Server-only search index builder.
 *
 * Walks every editorial surface the site exposes (benchmarks, products,
 * alternatives, answers, chains, compare pairs, top-level pages) and
 * emits one flat `SearchItem[]` for the client-side Fuse.js instance.
 *
 * Build-safe by design: only reads YAML specs and TypeScript registries.
 * Never touches Prometheus, KV, or any network, so calling this from
 * `app/layout.tsx` is cheap even on a cold build with no live data.
 */

import { cache } from "react";
import { loadSpecsUncached } from "@/lib/materialize/load";
import { loadAllAlternatives } from "@/lib/alternatives";
import { loadAllAnswers } from "@/lib/answers";
import { CHAINS } from "@/lib/chains";
import { COMPARE_PAIRS } from "@/data/compare-pairs";
import { PROVIDER_REGISTRY } from "@/data/provider-registry";
import { canonicalize, getProvider } from "@/lib/providers";
import type { SearchItem } from "@/lib/search/types";

/**
 * Top-level routes that aren't enumerated elsewhere. Hardcoded because
 * there are 14 of them and the list changes maybe once a quarter; an
 * auto-scanner over `src/app` would bring more noise than value.
 */
const STATIC_PAGES: Array<{ url: string; title: string; description: string; tags?: string[] }> = [
  {
    url: "/",
    title: "Home",
    description: "OpenChainBench. Open benchmarks for crypto infrastructure.",
  },
  {
    url: "/benchmarks",
    title: "All benchmarks",
    description: "Every live benchmark, grouped by category.",
    tags: ["index", "catalog"],
  },
  {
    url: "/products",
    title: "All products",
    description: "Every product tracked by OpenChainBench, grouped by performance.",
    tags: ["providers", "directory"],
  },
  {
    url: "/answers",
    title: "Answers",
    description: "Question-driven landing pages backed by live benchmark data.",
    tags: ["questions", "faq"],
  },
  {
    url: "/alternatives",
    title: "Alternatives",
    description: "Head-to-head alternatives pages for popular crypto products.",
  },
  {
    url: "/chains",
    title: "Chains",
    description: "Per-chain hubs that aggregate every benchmark for a given L1 or L2.",
  },
  {
    url: "/compare",
    title: "Compare",
    description: "Side-by-side comparisons for two providers across shared benchmarks.",
    tags: ["versus", "vs"],
  },
  {
    url: "/methodology",
    title: "Methodology",
    description: "How OpenChainBench runs harnesses, scrapes Prometheus, and ranks providers.",
  },
  {
    url: "/about",
    title: "About",
    description: "What OpenChainBench is, who runs it, and why it exists.",
  },
  {
    url: "/contribute",
    title: "Contribute",
    description: "How to add a new benchmark, harness, or provider.",
  },
  {
    url: "/press",
    title: "Press",
    description: "Brand assets, logos, and press contact.",
  },
  {
    url: "/partners",
    title: "Partners",
    description: "Organisations supporting OpenChainBench.",
  },
  {
    url: "/hyperliquid",
    title: "Hyperliquid hub",
    description: "Every benchmark that touches Hyperliquid, in one place.",
    tags: ["perps", "hl"],
  },
  {
    url: "/perps",
    title: "Perps hub",
    description: "Perpetual exchanges leaderboards and venue stats.",
    tags: ["derivatives", "futures"],
  },
  {
    url: "/prediction-markets",
    title: "Prediction markets",
    description: "Prediction market benchmarks across Polymarket and competitors.",
    tags: ["polymarket"],
  },
  {
    url: "/mcp",
    title: "MCP",
    description: "Model Context Protocol endpoint and tool surface.",
    tags: ["model context protocol", "ai"],
  },
];

/** Strip `{{best_name}}` / `{{best_p50}}` / `{{p50:slug}}` etc. tokens
 *  from raw YAML editorial copy. The search index is built at build time
 *  with no Prom data, so template tokens can't be resolved here. Leaving
 *  them raw ships `{{best_name}} leads ...` into the search dialog
 *  description preview, which reads as broken. */
function stripTemplates(s: string): string {
  return s.replace(/\{\{[^}]+\}\}/g, "").replace(/\s+/g, " ").trim();
}

function truncate(s: string | undefined, n = 150): string | undefined {
  if (!s) return undefined;
  const clean = stripTemplates(s);
  if (!clean) return undefined;
  if (clean.length <= n) return clean;
  return `${clean.slice(0, n - 1).trimEnd()}…`;
}

function providerNameFor(slug: string): string {
  // canonicalize() handles aliases (helius-sender → helius-sender, but
  // also covers historical renames) and falls back to title-casing the
  // slug when no display name is registered.
  return canonicalize(slug).name;
}

/**
 * Build the full index. Cached for the lifetime of the React server
 * runtime so repeated layout renders within a single deploy share work.
 */
export const buildSearchIndex = cache(async function buildSearchIndex(): Promise<SearchItem[]> {
  const [specs, alternatives, answers] = await Promise.all([
    loadSpecsUncached(),
    loadAllAlternatives(),
    loadAllAnswers(),
  ]);

  const items: SearchItem[] = [];

  // ── Benchmarks ──────────────────────────────────────────────────
  for (const spec of specs) {
    if (spec.status === "draft") continue;
    // Prefer subtitle over seo_description when the latter contains
    // template tokens. The index is built without Prom data so we can't
    // resolve `{{best_name}}` here, and showing the YAML with the tokens
    // stripped leaves a sentence with gaps ("leads ... at (p50, 24h)").
    const hasTokens = spec.seo_description?.includes("{{");
    const description = hasTokens ? spec.subtitle : (spec.seo_description ?? spec.subtitle);
    items.push({
      id: `bench:${spec.slug}`,
      kind: "Benchmark",
      title: spec.title,
      url: `/benchmarks/${spec.slug}`,
      description: truncate(description),
      tags: [spec.category, spec.slug],
    });
  }

  // ── Products ────────────────────────────────────────────────────
  for (const [slug, entry] of Object.entries(PROVIDER_REGISTRY)) {
    items.push({
      id: `product:${slug}`,
      kind: "Product",
      title: providerNameFor(slug),
      url: `/products/${slug}`,
      description: truncate(entry.description),
      tags: [slug, ...(entry.chains ?? [])],
    });
  }

  // ── Alternatives ────────────────────────────────────────────────
  for (const alt of alternatives) {
    items.push({
      id: `alt:${alt.slug}`,
      kind: "Alternative",
      title: alt.seo_title ?? `${alt.target_product} alternatives`,
      url: `/alternatives/${alt.slug}`,
      description: truncate(alt.description),
      tags: [alt.target_product, alt.slug, alt.benchmark],
    });
  }

  // ── Answers ─────────────────────────────────────────────────────
  for (const ans of answers) {
    items.push({
      id: `answer:${ans.slug}`,
      kind: "Answer",
      title: ans.question,
      url: `/answers/${ans.slug}`,
      description: truncate(ans.seo_description ?? ans.short_answer),
      tags: [ans.slug, ans.benchmark],
    });
  }

  // ── Chains ──────────────────────────────────────────────────────
  for (const chain of CHAINS) {
    items.push({
      id: `chain:${chain.slug}`,
      kind: "Chain",
      title: chain.label,
      url: `/chains/${chain.slug}`,
      description: truncate(chain.description),
      tags: [chain.slug, chain.category, chain.nativeSymbol ?? ""].filter(Boolean),
    });
  }

  // ── Compare pairs ───────────────────────────────────────────────
  // Mirror the filter applied by /compare/page.tsx: skip pairs where
  // either side is unresolved (provider deregistered, never imported,
  // or hex-blacklisted). Without this the search index keeps surfacing
  // jupiter-vs-raydium et al even after the compare page itself stops
  // rendering them, and Google / Ahrefs flag the embedded JSON as a
  // dead internal link.
  const resolvedPairs = await Promise.all(
    COMPARE_PAIRS.map(async (pair) => {
      const [a, b] = await Promise.all([
        getProvider(pair.providerA),
        getProvider(pair.providerB),
      ]);
      return a && b ? pair : null;
    }),
  );
  for (const pair of resolvedPairs) {
    if (!pair) continue;
    const a = providerNameFor(pair.providerA);
    const b = providerNameFor(pair.providerB);
    items.push({
      id: `compare:${pair.slug}`,
      kind: "Compare",
      title: `${a} vs ${b}`,
      url: `/compare/${pair.slug}`,
      description: truncate(`Head to head benchmark data for ${a} and ${b}.`),
      tags: [pair.providerA, pair.providerB, pair.slug, "vs", "versus"],
    });
  }

  // ── Static top-level pages ─────────────────────────────────────
  for (const page of STATIC_PAGES) {
    items.push({
      id: `page:${page.url}`,
      kind: "Page",
      title: page.title,
      url: page.url,
      description: truncate(page.description),
      tags: page.tags,
    });
  }

  return items;
});
