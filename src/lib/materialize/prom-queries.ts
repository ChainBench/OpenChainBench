/**
 * PromQL query-string helpers for materialize/load.
 *
 * Pure string transforms over PromQL queries declared in spec YAML.
 * Used by the live-load path to inject dimension labels (chain/region)
 * across provider/panel queries, and to parse the spec's window string.
 *
 * No Prometheus client, no persistence: safe to import from both the
 * Next.js site and the standalone worker.
 */

import type { Spec } from "@/lib/spec-schema";

export function injectLabels(query: string, labels: Record<string, string>): string {
  return query.replace(/\{([^}]*)\}/g, (_, inside: string) => {
    const additions: string[] = [];
    for (const [k, v] of Object.entries(labels)) {
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
export function escapePromLabelValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, "");
}

/** Inject every active `<label>="<value>"` into every PromQL label selector
 * across the spec's provider queries (including per-region subqueries).
 * Skips selectors that already filter by a given label. */
export function applyDimensionsToSpec(spec: Spec, labels: Record<string, string>): Spec {
  const inject = (q: string | undefined) => (q ? injectLabels(q, labels) : q);
  return {
    ...spec,
    // Panels declare a bare metric name (or metric{sel}); normalize to the
    // braced form so dimension labels (chain=..., region=...) reach them
    // like every provider query. Without this a panel on a chain-dimensioned
    // bench silently mixes every chain's series.
    metric_panels: spec.metric_panels?.map((panel) => ({
      ...panel,
      metric: injectLabels(
        panel.metric.includes("{") ? panel.metric : `${panel.metric}{}`,
        labels,
      ),
    })),
    providers: spec.providers.map((p) => ({
      ...p,
      queries: p.queries
        ? {
            ...p.queries,
            p50: inject(p.queries.p50),
            p90: inject(p.queries.p90),
            p99: inject(p.queries.p99),
            mean: inject(p.queries.mean),
            success: inject(p.queries.success),
            sample_size: inject(p.queries.sample_size),
            series: inject(p.queries.series),
            regions: p.queries.regions?.map((r) => ({
              ...r,
              p50: inject(r.p50),
              series: inject(r.series),
            })),
          }
        : p.queries,
    })),
  };
}

export function parseDurationSec(d: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(d.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  return n * { s: 1, m: 60, h: 3600, d: 86_400 }[unit as "s" | "m" | "h" | "d"];
}
