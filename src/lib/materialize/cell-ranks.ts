/**
 * Per-cell ranking loader for materialize/load.
 *
 * Self-contained Prom call + folding logic for `spec.rank_matrix_query`.
 * Owns its own Prom error handling: any failure returns undefined so
 * badge/product surfaces fall back to the coarser bestPerChain path
 * computed by the orchestrator.
 */

import type { CellRankEntry } from "@/types/benchmark";
import { isAll } from "@/lib/dimensions";
import { getPrometheus } from "@/lib/prometheus";
import type { Spec } from "@/lib/spec-schema";

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
export async function tryLoadCellRanks(
  spec: Spec,
): Promise<Record<string, CellRankEntry[]> | undefined> {
  if (!spec.rank_matrix_query) return undefined;
  const url = spec.prometheus?.url ?? process.env.PROMETHEUS_URL;
  if (!url) return undefined;
  try {
    const prom = getPrometheus(url);
    const res = await prom.query(spec.rank_matrix_query);
    if (res.resultType !== "vector") return undefined;

    const slugByLower = new Map(
      spec.providers.map((p) => [p.slug.toLowerCase(), p.slug] as const),
    );
    // Canonical dimension value by lowercase, so a harness emitting
    // `chain="Base"` still maps onto the declared `base` value instead
    // of silently dropping the cell.
    const chainByLower = new Map(
      (spec.dimensions?.chain ?? [])
        .filter((c) => !isAll(c.value))
        .map((c) => [c.value.toLowerCase(), c.value] as const),
    );
    const regionByLower = new Map(
      (spec.dimensions?.region ?? [])
        .filter((r) => !isAll(r.value))
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
    return out;
  } catch (e) {
    console.warn(
      `cellRanks skip: ${spec.slug} matrix query failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}
