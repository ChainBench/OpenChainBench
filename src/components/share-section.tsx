"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Image as ImageIcon, Loader2, X } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { Hint } from "@/components/hint";

/** Dimensions the share-card handler on the server understands. Kept in
 *  sync with the pickOption() dims in
 *  src/app/benchmarks/[slug]/share-card/route.tsx. */
const SCOPE_DIMS = ["chain", "region", "venue", "kind"] as const;
type ScopeDim = (typeof SCOPE_DIMS)[number];

/** Human-readable label for each dimension dropdown. */
const DIM_LABEL: Record<ScopeDim, string> = {
  chain: "Chain",
  region: "Region",
  venue: "Venue",
  kind: "Kind",
};

/** Sentinel value the dropdowns use for "no filter on this dimension".
 *  Same as the bench detail page and the share-card server handler. */
const ALL_VALUE = "all";

type Template = {
  id: string;
  label: string;
  description: string;
  /** What kind of selection UI this template supports. */
  pick: "none" | "multi" | "single" | "pair";
};

const TEMPLATES: Template[] = [
  {
    id: "ranking",
    label: "Ranking",
    description: "Vertical bars sorted ascending by p50, with provider names and p99 tails.",
    pick: "none",
  },
  {
    id: "leaderboard",
    label: "Leaderboard",
    description: "Ranked rows with horizontal mini-bars in each provider's signature color.",
    pick: "none",
  },
  {
    id: "snapshot",
    label: "Snapshot",
    description: "Full 24-hour multi-line chart. Toggle providers in or out of the plot.",
    pick: "multi",
  },
  {
    id: "headline",
    label: "Headline",
    description: "Big-number poster of one provider's p50. Pick which provider to feature.",
    pick: "single",
  },
  {
    id: "compare",
    label: "Compare",
    description: "Two providers head-to-head. Pick the pair you want to compare.",
    pick: "pair",
  },
];

type Props = {
  slug: string;
  title: string;
  benchmark: Benchmark;
  /** When the bench page is filtered by chain, propagate it to the
   * share-card so the generated PNG renders with the same scope. */
  chain?: string | null;
};

export function ShareSection({ slug, title, benchmark, chain }: Props) {
  const [activeId, setActiveId] = useState<string>("ranking");
  const [open, setOpen] = useState(false);

  // Which dimensions this bench actually declares. Only those get a
  // dropdown in the modal; the rest are hidden. Kept as a plain object
  // so template rendering can `dimOptions.venue?.length` without a
  // per-render `.filter().find()` pass.
  const dimOptions = useMemo(() => {
    const out: Partial<Record<ScopeDim, { value: string; label: string }[]>> = {};
    for (const dim of SCOPE_DIMS) {
      const opts = benchmark.dimensions?.[dim] ?? [];
      // Drop the synthetic "all" option if the spec includes it: the
      // modal always prepends its own "All" entry as the default so
      // duplicating breaks the value equality check on select onChange.
      const filtered = opts.filter((o) => o.value !== ALL_VALUE);
      if (filtered.length > 0) out[dim] = filtered;
    }
    return out;
  }, [benchmark]);
  const hasAnyDim = Object.keys(dimOptions).length > 0;

  // Metric-panel options. Benches like perp-fees expose companion
  // scalars via `metricPanels` (e.g. ALL-IN AT $1K / $100K / $1M).
  // The on-page ViewSwitcher writes ?view=<id>; the modal reads the
  // same URL on open and lets the reader retarget the export to any
  // panel without leaving the dashboard. Dropped when the spec has 0
  // or 1 panels (a single-view bench doesn't need the picker at all).
  const panelOptions = useMemo(
    () =>
      (benchmark.metricPanels ?? [])
        .filter((p) => p.tab !== false)
        .map((p) => ({ value: p.id, label: p.label })),
    [benchmark],
  );
  const hasPanels = panelOptions.length > 0;

  // Scope state: one entry per SCOPE_DIMS. Default is "all" per dim.
  // Re-seeded from window.location every time the modal opens, so the
  // dropdowns start on whatever the reader was filtering on the
  // dashboard (not surprising) but can be changed freely from inside
  // the modal.
  const [scope, setScope] = useState<Record<ScopeDim, string>>({
    chain: chain ?? ALL_VALUE,
    region: ALL_VALUE,
    venue: ALL_VALUE,
    kind: ALL_VALUE,
  });
  // View (metric panel) state, orthogonal to SCOPE_DIMS. ALL_VALUE
  // means "main spec metric" (no ?view= param). Re-seeded on open like
  // the scope dropdowns.
  const [panelView, setPanelView] = useState<string>(ALL_VALUE);
  // Re-seed scope from URL on each open transition. Uses the "adjust
  // state during render on transition" pattern instead of a useEffect
  // (react-hooks/set-state-in-effect flags synchronous setState calls
  // inside effect bodies). `prevOpen` gates the reseed so subsequent
  // renders while the modal stays open don't clobber the dropdowns.
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const next: Record<ScopeDim, string> = {
        chain: url.searchParams.get("chain") || ALL_VALUE,
        region: url.searchParams.get("region") || ALL_VALUE,
        venue: url.searchParams.get("venue") || ALL_VALUE,
        kind: url.searchParams.get("kind") || ALL_VALUE,
      };
      // Coerce values the current bench does not offer back to "all".
      // A chain the reader was previously filtering by can vanish
      // between deploys (spec edit); silently falling back beats a
      // broken picker.
      for (const dim of SCOPE_DIMS) {
        const opts = dimOptions[dim];
        if (
          opts &&
          next[dim] !== ALL_VALUE &&
          !opts.some((o) => o.value === next[dim])
        ) {
          next[dim] = ALL_VALUE;
        }
      }
      setScope(next);
      const urlView = url.searchParams.get("view");
      if (urlView && panelOptions.some((o) => o.value === urlView)) {
        setPanelView(urlView);
      } else {
        setPanelView(ALL_VALUE);
      }
    }
  }

  // Lock body scroll while modal open and close on Escape.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const orderedProviders = useMemo(
    () =>
      [...benchmark.results]
        .sort(
          benchmark.higherIsBetter
            ? (a, b) => b.ms.p50 - a.ms.p50
            : (a, b) => a.ms.p50 - b.ms.p50,
        )
        .map((r) => ({ slug: r.slug, name: r.name })),
    [benchmark]
  );

  // Snapshot: multi-select, default = all
  const [multiSelected, setMultiSelected] = useState<Set<string>>(
    () => new Set(orderedProviders.map((p) => p.slug))
  );

  // Headline: single-select, default = winner (first by p50)
  const [singleSelected, setSingleSelected] = useState<string | null>(
    () => orderedProviders[0]?.slug ?? null
  );

  // Compare: pair, default = top 2
  const [pairA, setPairA] = useState<string | null>(
    () => orderedProviders[0]?.slug ?? null
  );
  const [pairB, setPairB] = useState<string | null>(
    () => orderedProviders[1]?.slug ?? null
  );

  function toggleMulti(slug: string) {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function pickPairA(s: string) {
    if (s === pairB) setPairB(pairA); // swap to keep both filled
    setPairA(s);
  }

  function pickPairB(s: string) {
    if (s === pairA) setPairA(pairB);
    setPairB(s);
  }

  // Build the URL with the right params per template. Scope state is
  // the source of truth: the modal dropdowns own it, so the preview
  // and download always agree with what the user picked inside the
  // modal (not what happened to be in window.location at open time).
  const cardSrc = (templateId: string) => {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    const dimParams: string[] = [];
    for (const dim of SCOPE_DIMS) {
      const val = scope[dim];
      if (val && val !== ALL_VALUE) {
        dimParams.push(`&${dim}=${encodeURIComponent(val)}`);
      }
    }
    if (panelView && panelView !== ALL_VALUE) {
      dimParams.push(`&view=${encodeURIComponent(panelView)}`);
    }
    // Mirror the active site theme so the exported PNG matches what the
    // user is looking at. SSR can't read the dark state - default to light
    // server-side, the client re-renders with `dark` once mounted.
    const isDark =
      typeof window !== "undefined" &&
      document.documentElement.classList.contains("dark");
    const themeParam = isDark ? "&theme=dark" : "";
    const base = `/benchmarks/${slug}/share-card?template=${templateId}${dimParams.join("")}${themeParam}`;
    if (!tpl) return base;
    if (tpl.pick === "multi") {
      if (
        multiSelected.size === orderedProviders.length ||
        multiSelected.size === 0
      ) {
        return base;
      }
      const list = orderedProviders
        .filter((p) => multiSelected.has(p.slug))
        .map((p) => p.slug)
        .join(",");
      return `${base}&providers=${encodeURIComponent(list)}`;
    }
    if (tpl.pick === "single" && singleSelected) {
      return `${base}&provider=${encodeURIComponent(singleSelected)}`;
    }
    if (tpl.pick === "pair" && pairA && pairB) {
      return `${base}&a=${encodeURIComponent(pairA)}&b=${encodeURIComponent(pairB)}`;
    }
    return base;
  };

  async function handleDownload(templateId: string) {
    const url = cardSrc(templateId);
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${slug}-${templateId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error("download failed", err);
    }
  }

  return (
    <>
      <Hint label="Export image">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Export image"
          className="inline-flex items-center justify-center rounded-md border border-ink/15 bg-paper p-1.5 text-ink shadow-sm transition-colors hover:bg-paper-soft"
        >
          <ImageIcon size={13} strokeWidth={2} />
        </button>
      </Hint>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-4xl rounded-md border border-rule bg-paper shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rule px-4 sm:px-6 py-4">
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
                Export as image · 5 layouts
              </span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-ink-muted hover:text-ink transition-colors"
              >
                <X size={20} strokeWidth={2} />
              </button>
            </div>
      <div className="px-4 sm:px-6 py-5 space-y-5">
        <p className="text-sm text-ink-muted leading-relaxed max-w-2xl">
          Pick a layout and download a 1200×630 PNG ready for Twitter, Reddit, LinkedIn or any OG-card embed. Same data, same colors as this dashboard.
        </p>

        {(hasAnyDim || hasPanels) && (
          <ScopePicker
            dimOptions={dimOptions}
            scope={scope}
            onChange={(dim, value) =>
              setScope((prev) => ({ ...prev, [dim]: value }))
            }
            onReset={() => {
              setScope({
                chain: ALL_VALUE,
                region: ALL_VALUE,
                venue: ALL_VALUE,
                kind: ALL_VALUE,
              });
              setPanelView(ALL_VALUE);
            }}
            slug={slug}
            panelOptions={panelOptions}
            panelView={panelView}
            onPanelChange={setPanelView}
            mainLabel={benchmark.panelMainLabel ?? benchmark.metric}
          />
        )}

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-1 border border-rule rounded p-1 bg-paper-soft w-fit">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded transition-colors ${
                activeId === t.id
                  ? "bg-paper text-ink shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {TEMPLATES.map((t) => {
          if (t.id !== activeId) return null;
          return (
            <div key={t.id} className="space-y-3">
              <p className="text-xs text-ink-muted">{t.description}</p>

              {/* Multi-select (snapshot) */}
              {t.pick === "multi" && (
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mr-1">
                      Lines on chart
                    </span>
                    {orderedProviders.map((p) => {
                      const isOn = multiSelected.has(p.slug);
                      return (
                        <button
                          key={p.slug}
                          onClick={() => toggleMulti(p.slug)}
                          className={`px-2.5 py-1 rounded-full border text-[11px] font-medium uppercase tracking-[0.12em] transition-colors ${
                            isOn
                              ? "bg-ink text-paper border-ink"
                              : "bg-paper-soft text-ink-muted border-rule hover:text-ink"
                          }`}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                    <button
                      onClick={() =>
                        setMultiSelected(
                          new Set(orderedProviders.map((p) => p.slug))
                        )
                      }
                      className="ml-1 text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink lnk"
                    >
                      All
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                    {multiSelected.size} of {orderedProviders.length} on chart
                    {multiSelected.size === 0 && " · empty selection falls back to all"}
                  </p>
                </div>
              )}

              {/* Single-pick (headline) */}
              {t.pick === "single" && (
                <div>
                  <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-2">
                    Featured provider
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {orderedProviders.map((p) => {
                      const isOn = singleSelected === p.slug;
                      return (
                        <button
                          key={p.slug}
                          onClick={() => setSingleSelected(p.slug)}
                          className={`px-3 py-1.5 rounded-full border text-[11px] font-medium uppercase tracking-[0.12em] transition-colors ${
                            isOn
                              ? "bg-ink text-paper border-ink"
                              : "bg-paper-soft text-ink-muted border-rule hover:text-ink"
                          }`}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Pair-pick (compare) */}
              {t.pick === "pair" && (
                <div className="border border-rule rounded p-4 bg-paper-soft">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink">
                      Pick 2 providers to compare
                    </span>
                    <button
                      onClick={() => {
                        const a = pairA;
                        setPairA(pairB);
                        setPairB(a);
                      }}
                      className="ml-auto text-[10px] uppercase tracking-[0.14em] text-ink-muted hover:text-ink lnk inline-flex items-center gap-1"
                    >
                      Swap A and B
                    </button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
                    <div>
                      <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-2">
                        Provider A · left
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {orderedProviders.map((p) => {
                          const isOn = pairA === p.slug;
                          const disabled = pairB === p.slug;
                          return (
                            <button
                              key={p.slug}
                              onClick={() => pickPairA(p.slug)}
                              className={`px-3 py-1.5 rounded border text-[11px] font-medium uppercase tracking-[0.12em] transition-colors ${
                                isOn
                                  ? "bg-ink text-paper border-ink shadow-sm"
                                  : disabled
                                  ? "bg-paper text-ink-faint border-rule opacity-60"
                                  : "bg-paper text-ink-muted border-rule hover:text-ink"
                              }`}
                            >
                              {p.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center self-center text-ink-faint text-[14px] font-semibold italic pt-6">
                      vs
                    </div>
                    <div>
                      <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mb-2">
                        Provider B · right
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {orderedProviders.map((p) => {
                          const isOn = pairB === p.slug;
                          const disabled = pairA === p.slug;
                          return (
                            <button
                              key={p.slug}
                              onClick={() => pickPairB(p.slug)}
                              className={`px-3 py-1.5 rounded border text-[11px] font-medium uppercase tracking-[0.12em] transition-colors ${
                                isOn
                                  ? "bg-ink text-paper border-ink shadow-sm"
                                  : disabled
                                  ? "bg-paper text-ink-faint border-rule opacity-60"
                                  : "bg-paper text-ink-muted border-rule hover:text-ink"
                              }`}
                            >
                              {p.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <SharePreview
                key={cardSrc(t.id)}
                src={cardSrc(t.id)}
                alt={`${title}. ${t.label} share card`}
              />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => handleDownload(t.id)}
                  className="btn-primary btn-primary--sm inline-flex items-center gap-1.5"
                >
                  <Download size={14} strokeWidth={2.2} />
                  Download PNG
                </button>
                <a
                  href={cardSrc(t.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium uppercase tracking-[0.14em] text-ink-muted hover:text-ink"
                >
                  Open raw ↗
                </a>
              </div>
            </div>
          );
        })}
      </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Dropdown row that lets the reader override chain / region / venue /
 *  kind from inside the modal. Only rendered for dims the bench actually
 *  declares (chain-less benches never see a chain dropdown, etc.).
 *
 *  Pings /api/stat/<slug>?<filters> after each pick so the user sees a
 *  "no data for this cell" hint before wasting a PNG download. The stat
 *  endpoint returns 404 on unknown filter combos (see route.ts comment
 *  "does NOT fall back to the unfiltered aggregate"), which is exactly
 *  the signal we need. */
function ScopePicker({
  dimOptions,
  scope,
  onChange,
  onReset,
  slug,
  panelOptions,
  panelView,
  onPanelChange,
  mainLabel,
}: {
  dimOptions: Partial<Record<ScopeDim, { value: string; label: string }[]>>;
  scope: Record<ScopeDim, string>;
  onChange: (dim: ScopeDim, value: string) => void;
  onReset: () => void;
  slug: string;
  panelOptions: { value: string; label: string }[];
  panelView: string;
  onPanelChange: (v: string) => void;
  mainLabel: string;
}) {
  const activeDims = SCOPE_DIMS.filter((d) => dimOptions[d]);
  const hasFilter =
    activeDims.some((d) => scope[d] !== ALL_VALUE) || panelView !== ALL_VALUE;

  // Data-existence probe. `probe.key` is the URL we last resolved; the
  // rendered status is derived (below), so the effect body only needs
  // async setState inside .then() / .catch() callbacks — no sync
  // setState-in-effect (blocked by react-hooks/set-state-in-effect).
  const probeKey = useMemo(() => {
    if (!hasFilter) return "";
    const qs = new URLSearchParams();
    for (const d of activeDims) {
      if (scope[d] !== ALL_VALUE) qs.set(d, scope[d]);
    }
    // /api/stat doesn't apply metric-panel overrides, so we only include
    // scope dims in the probe URL. The panel choice is validated
    // separately via panelOptions membership; a bad panel id is not a
    // "no data for this cell" state, it just can't happen from the
    // dropdown at all.
    return `/api/stat/${slug}?${qs.toString()}`;
  }, [slug, activeDims, scope, hasFilter]);
  const [probe, setProbe] = useState<{
    key: string;
    result: "ok" | "empty" | null;
  }>({ key: "", result: null });
  const status: "ok" | "empty" | "checking" | "idle" = !hasFilter
    ? "idle"
    : probe.key !== probeKey || probe.result == null
      ? "checking"
      : probe.result;

  useEffect(() => {
    if (!probeKey) return;
    const ctrl = new AbortController();
    fetch(probeKey, { signal: ctrl.signal })
      .then((r) => {
        if (r.status === 404) return { rankings: [] as unknown[] };
        return r.json();
      })
      .then((json: { rankings?: unknown[]; leader?: unknown } | undefined) => {
        const hasRows =
          !!json && Array.isArray(json.rankings) && json.rankings.length > 0;
        setProbe({ key: probeKey, result: hasRows ? "ok" : "empty" });
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        setProbe({ key: probeKey, result: "empty" });
      });
    return () => ctrl.abort();
  }, [probeKey]);

  return (
    <div className="border border-rule rounded p-3 bg-paper-soft">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint pb-1.5">
          Scope
        </span>
        {activeDims.map((dim) => {
          const opts = dimOptions[dim]!;
          return (
            <label key={dim} className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-muted">
                {DIM_LABEL[dim]}
              </span>
              <select
                value={scope[dim]}
                onChange={(e) => onChange(dim, e.target.value)}
                className="rounded border border-rule bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
              >
                <option value={ALL_VALUE}>All</option>
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        {panelOptions.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-muted">
              View
            </span>
            <select
              value={panelView}
              onChange={(e) => onPanelChange(e.target.value)}
              className="rounded border border-rule bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-ink/20"
            >
              {/* Default view label falls back to `panelMainLabel` when
                  the spec provides one (perp-fees ships "All-in at $1k"),
                  else the spec's headline metric. "Main metric" was a
                  generic placeholder that read as an extra fake option to
                  readers who saw 3 tabs on-page but only 2 named entries
                  plus "Main metric" in the dropdown. */}
              <option value={ALL_VALUE}>{mainLabel}</option>
              {panelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {hasFilter && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto text-[10px] uppercase tracking-[0.14em] text-ink-muted hover:text-ink lnk pb-1.5"
          >
            Reset
          </button>
        )}
      </div>
      {status === "checking" && (
        <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
          Checking data for this cell…
        </p>
      )}
      {status === "empty" && (
        <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-amber-600">
          No data for this scope. Card will fall back to the aggregate.
        </p>
      )}
    </div>
  );
}

/** Preview frame with a "Generating preview…" overlay while the PNG loads. */
function SharePreview({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  // Reset during render when src changes (the documented "adjust state
  // when a prop changes" pattern) instead of a setState-in-effect.
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setLoaded(false);
    setError(false);
  }

  return (
    <div className="relative border border-rule rounded overflow-hidden bg-paper-soft aspect-[1200/630]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        width={1200}
        height={630}
        className={`w-full h-auto transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setError(true);
          setLoaded(true);
        }}
      />
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
          <Loader2 size={28} strokeWidth={1.6} className="animate-spin" />
          <span className="text-[11px] font-medium uppercase tracking-[0.16em]">
            Generating preview…
          </span>
        </div>
      )}
      {error && loaded && (
        <div className="absolute inset-0 flex items-center justify-center text-ink-muted text-sm">
          Failed to generate this preview.
        </div>
      )}
    </div>
  );
}
