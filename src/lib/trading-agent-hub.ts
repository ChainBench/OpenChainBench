import { unstable_cache } from "next/cache";
import { loadBenchFromBlob } from "@/lib/bench-blob";

/**
 * Data for /trading-agents.
 *
 * The hub reads one bench today (284, trading-agent-alpha) and is shaped to
 * read several. The grouping it adds on top is by LAB rather than by agent:
 * the arena runs most models twice, once fed numeric data and once fed an
 * image, so eight rows are four models. Ranking the eight flat invites the
 * reader to treat "grok 4 chart" and "grok 4 vision" as two competitors when
 * they are one model under two input conditions.
 */

export type AgentRow = {
  slug: string;
  name: string;
  /** What the model was fed: numbers or an image of the same chart. */
  modality: "chart" | "vision";
  alpha: number | null;
  ret: number | null;
  passive: number | null;
  asset: number | null;
  hitRate: number | null;
  beta: number | null;
  rounds: number | null;
};

export type LabRow = {
  slug: string;
  name: string;
  model: string;
  agents: AgentRow[];
  /** Best alpha among the lab's agents, for ordering the groups. */
  bestAlpha: number | null;
};

export type TradingAgentHub = {
  labs: LabRow[];
  agents: AgentRow[];
  agentCount: number;
  labCount: number;
  /** Agents whose alpha is above zero, i.e. that beat holding their own
   *  exposure. The headline of the page is that this is currently zero. */
  beatingPassive: number;
  bestName: string | null;
  bestAlpha: number | null;
  worstName: string | null;
  worstAlpha: number | null;
  /** Rounds behind the deepest-sampled agent, for the "as measured over"
   *  line. Agents differ because they did not all fund the same weeks. */
  maxRounds: number | null;
  minRounds: number | null;
  asOf: string | null;
};

/** Which lab makes which model. The bench's own rows are agents, so the lab
 *  is editorial: it comes from the model named in each agent, nothing in the
 *  upstream data states it. Mirrors PRODUCT_ALIASES in providers.ts, which
 *  folds the same eight slugs onto four product pages. */
const LABS: { slug: string; name: string; model: string; agents: string[] }[] = [
  { slug: "google-deepmind", name: "Google DeepMind", model: "Gemini 3 Pro", agents: ["gemini-3-pro-chart", "gemini-3-pro-vision"] },
  { slug: "xai", name: "xAI", model: "Grok 4", agents: ["grok-4-chart", "grok-4-vision"] },
  { slug: "anthropic", name: "Anthropic", model: "Opus 4.5 and Sonnet 4.5", agents: ["opus-45-chart", "sonnet-45-vision"] },
  { slug: "openai", name: "OpenAI", model: "GPT-5.2", agents: ["gpt-52-chart", "gpt-52-vision"] },
];

function panelValue(
  panels: { id: string; values: Record<string, number> }[] | undefined,
  id: string,
  slug: string,
): number | null {
  const v = panels?.find((p) => p.id === id)?.values?.[slug];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function _fetchTradingAgentHub(): Promise<TradingAgentHub | null> {
  const bench = await loadBenchFromBlob("trading-agent-alpha");
  if (!bench || !bench.results?.length) return null;

  const panels = bench.metricPanels as
    | { id: string; values: Record<string, number> }[]
    | undefined;

  const bySlug = new Map(bench.results.map((r) => [r.slug, r]));
  const agents: AgentRow[] = [];

  for (const lab of LABS) {
    for (const slug of lab.agents) {
      const r = bySlug.get(slug);
      if (!r || r.availability === "unavailable") continue;
      agents.push({
        slug,
        name: r.name,
        modality: slug.endsWith("-vision") ? "vision" : "chart",
        alpha: Number.isFinite(r.ms?.p50) ? r.ms.p50 : null,
        ret: panelValue(panels, "raw_return", slug),
        passive: panelValue(panels, "passive", slug),
        asset: panelValue(panels, "asset_hold", slug),
        hitRate: panelValue(panels, "hit_rate", slug),
        beta: panelValue(panels, "exposure", slug),
        // The rounds panel and the result's own sampleSize are the same
        // figure from two paths; prefer the panel and fall back, so the
        // column holds a number even on a sweep that missed the panels.
        rounds: panelValue(panels, "n_rounds", slug) ?? r.sampleSize ?? null,
      });
    }
  }
  if (agents.length === 0) return null;

  const labs: LabRow[] = LABS.map((lab) => {
    const mine = agents.filter((a) => lab.agents.includes(a.slug));
    const alphas = mine.map((a) => a.alpha).filter((v): v is number => v != null);
    return {
      slug: lab.slug,
      name: lab.name,
      model: lab.model,
      agents: mine.sort((a, b) => (b.alpha ?? -Infinity) - (a.alpha ?? -Infinity)),
      bestAlpha: alphas.length ? Math.max(...alphas) : null,
    };
  })
    .filter((l) => l.agents.length > 0)
    .sort((a, b) => (b.bestAlpha ?? -Infinity) - (a.bestAlpha ?? -Infinity));

  const ranked = [...agents]
    .filter((a) => a.alpha != null)
    .sort((a, b) => (b.alpha as number) - (a.alpha as number));

  const roundCounts = agents
    .map((a) => a.rounds)
    .filter((v): v is number => v != null && v > 0);

  return {
    labs,
    agents: ranked,
    agentCount: agents.length,
    labCount: labs.length,
    beatingPassive: ranked.filter((a) => (a.alpha as number) > 0).length,
    bestName: ranked[0]?.name ?? null,
    bestAlpha: ranked[0]?.alpha ?? null,
    worstName: ranked.at(-1)?.name ?? null,
    worstAlpha: ranked.at(-1)?.alpha ?? null,
    maxRounds: roundCounts.length ? Math.max(...roundCounts) : null,
    minRounds: roundCounts.length ? Math.min(...roundCounts) : null,
    asOf: bench.lastRunAt ?? null,
  };
}

export const fetchTradingAgentHub = unstable_cache(
  _fetchTradingAgentHub,
  ["trading-agent-hub"],
  { revalidate: 300 },
);
