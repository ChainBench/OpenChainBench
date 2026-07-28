"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Video, X, Check, Loader2, Download, Copy, Share2 } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { Hint } from "@/components/hint";
import { EXPORT_VIDEO_ENABLED } from "@/lib/export-video/config";
import { fetchBenchSeries } from "@/lib/export-video/fetch-series";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import {
  RANGE_IDS,
  RANGE_LABEL,
  VIEW_IDS,
  VIEW_LABEL,
  type BenchPayload,
  type RangeId,
  type RenderState,
  type ViewId,
} from "@/lib/export-video/types";
import { matchesChainSlug } from "@/lib/chain-aliases";

/** The four drill-down dimensions a spec can declare. Rendered in this
 *  order so the modal mirrors the tab order on the bench page. */
const DIM_IDS = ["chain", "region", "kind", "venue"] as const;
type DimId = (typeof DIM_IDS)[number];
const DIM_LABEL: Record<DimId, string> = {
  chain: "Chain",
  region: "Region",
  kind: "Kind",
  venue: "Venue",
};
type DimOption = { value: string; label: string };
type DimState = Partial<Record<DimId, string | null>>;

/** Providers with a live number in the current view. "unavailable"
 *  covers both offline and unresponsive rows; neither can appear in the
 *  video (their p50 is a zero placeholder, not a measurement). */
const hasData = (r: Benchmark["results"][number]) =>
  r.availability !== "unavailable";

type Props = {
  slug: string;
  title: string;
  benchmark: Benchmark;
};

/**
 * Export Video modal trigger.
 *
 * Mirrors `share-section.tsx` UX (hand-rolled overlay, Esc + scroll
 * lock) but produces an MP4 instead of a PNG. The render itself
 * happens off-box on a standalone Remotion service — this component
 * just collects the config, POSTs `/api/video/render`, then embeds
 * the returned URL in a <video> tag with share/download/copy actions.
 *
 * Gated by NEXT_PUBLIC_EXPORT_VIDEO at the render entry point; if the
 * flag isn't on, this component renders nothing (no DOM, no bundle weight).
 */
export function ExportVideoSection({ slug, title, benchmark }: Props) {
  // Hide on environments without the flag set. The flag is read at build
  // time via NEXT_PUBLIC_; flipping it requires a redeploy, which is the
  // exact rollback we want for a feature still in soak.
  if (!EXPORT_VIDEO_ENABLED) return null;

  return <ExportVideoModal slug={slug} title={title} benchmark={benchmark} />;
}

function ExportVideoModal({ slug, title, benchmark }: Props) {
  const [open, setOpen] = useState(false);

  // Lock body scroll + Esc to close. Same pattern share-section.tsx uses.
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

  return (
    <>
      <Hint label="Export video">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Export video"
          className="inline-flex items-center justify-center rounded-md border border-ink/15 bg-paper p-1.5 text-ink shadow-sm transition-colors hover:bg-paper-soft"
        >
          <Video size={13} strokeWidth={2} />
        </button>
      </Hint>

      {open && (
        <ModalBody
          slug={slug}
          title={title}
          benchmark={benchmark}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ModalBody({
  slug,
  benchmark,
  onClose,
}: Props & { onClose: () => void }) {
  const [range, setRange] = useState<RangeId>("30d");
  const [view, setView] = useState<ViewId>("BarChartRace");
  // 12s default — long enough to land the trajectory, short enough to keep
  // the first-render wall-clock under 30-40s on the standard VPS. User can
  // bump via the slider when they want a longer race.
  const [raceSeconds, setRaceSeconds] = useState(12);
  const [skipIntro, setSkipIntro] = useState(false);
  // "short" renders natively at 1080x1920 (TikTok / Reels / Shorts); the
  // renderer overrides the Remotion canvas, no crop or scale involved.
  const [format, setFormat] = useState<"landscape" | "short">("landscape");
  // Ambient soundtrack muxed server-side: cut to the exact video length
  // with a 2.5s fade-out. Off by default.
  const [audio, setAudio] = useState(false);
  // Story beats: lead-change banners during the race. Off by default.
  const [beats, setBeats] = useState(false);
  const [state, setState] = useState<RenderState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  // Metric-panel picker. Benches with companion metrics (e.g. hyperliquid-frontends
  // exposes Revenue / Volume / Users / Effective fee / Outage tabs) can race any
  // of those via the panel picker. `tab: false` panels are data-only (no series)
  // and are excluded. Seeds from ?view= in the URL, same as the bench page.
  const panelOptions = useMemo(
    () =>
      (benchmark.metricPanels ?? [])
        .filter((p) => p.tab !== false)
        .map((p) => ({ value: p.id, label: p.label })),
    [benchmark],
  );

  // Dimension pickers. One pill row per dimension the spec declares
  // (chain, region, kind, venue), each with an "All" pill meaning no
  // filter. The bench page's URL filters (?chain=ethereum) seed the
  // initial selection so a video exported from a chain-scoped tab
  // defaults to the chain-scoped series, but the user can repick any
  // combination without leaving the modal.
  const searchParams = useSearchParams();
  const dimOptions = useMemo(() => {
    const out: Partial<Record<DimId, DimOption[]>> = {};
    for (const dim of DIM_IDS) {
      const entries = (benchmark.dimensions?.[dim] ?? []).filter(
        (d) => d.value.toLowerCase() !== "all",
      );
      if (entries.length > 0) out[dim] = entries;
    }
    return out;
  }, [benchmark]);
  const [dims, setDims] = useState<DimState>(() => {
    const out: DimState = {};
    for (const dim of DIM_IDS) {
      const raw = searchParams.get(dim)?.toLowerCase().trim();
      if (!raw || raw === "all") continue;
      // Canonical-aware chain lookup: ?chain=gram still selects the
      // dimension whose YAML value is the legacy "ton".
      const match = (benchmark.dimensions?.[dim] ?? []).find((d) =>
        dim === "chain" ? matchesChainSlug(d.value, raw) : d.value.toLowerCase() === raw,
      );
      if (match && match.value.toLowerCase() !== "all") out[dim] = match.value;
    }
    return out;
  });

  // Metric panel selection. Seeds from ?view= in URL.
  const [panelId, setPanelId] = useState<string | null>(() => {
    const raw = searchParams.get("view")?.trim();
    if (!raw || raw === "all") return null;
    const found = (benchmark.metricPanels ?? []).find(
      (p) => p.id === raw && p.tab !== false,
    );
    return found?.id ?? null;
  });
  const activeMetricPanel = panelId
    ? (benchmark.metricPanels ?? []).find((p) => p.id === panelId) ?? null
    : null;
  const setDim = (dim: DimId, value: string | null) =>
    setDims((prev) => ({ ...prev, [dim]: value }));
  // Active filters (unset / "all" excluded), in declared order.
  const activeDims = useMemo(
    () =>
      DIM_IDS.flatMap((dim) => {
        const v = dims[dim];
        if (!v || v === "all" || !dimOptions[dim]) return [];
        const opt = dimOptions[dim]!.find((o) => o.value === v);
        return opt ? [{ dim, value: opt.value, label: opt.label }] : [];
      }),
    [dims, dimOptions],
  );
  const hasDims = activeDims.length > 0;

  // Variant data. When any dimension filter is active, fetch the filtered
  // Benchmark from the same on-demand route the bench page tabs use. The
  // fetched bench is stored WITH the filter key it answers, so loading /
  // stale states derive from a key comparison instead of extra setState
  // calls; a failed fetch stores null and the preview reports the empty
  // state rather than silently showing cross-dimension numbers.
  const dimKey = activeDims.map((d) => `${d.dim}=${d.value}`).join("&");
  const [variantState, setVariantState] = useState<{
    key: string;
    bench: Benchmark | null;
  } | null>(null);
  useEffect(() => {
    if (!hasDims) return; // the aggregate prop already covers "all"
    const qs = new URLSearchParams();
    for (const { dim, value } of activeDims) qs.set(dim, value);
    let cancelled = false;
    fetch(`/api/bench/${encodeURIComponent(slug)}/variant?${qs.toString()}`)
      .then((r) => (r.ok ? (r.json() as Promise<Benchmark>) : null))
      .then((v) => {
        if (!cancelled) setVariantState({ key: dimKey, bench: v ?? null });
      })
      .catch(() => {
        if (!cancelled) setVariantState({ key: dimKey, bench: null });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, activeDims, hasDims, dimKey]);
  const variant = variantState?.key === dimKey ? variantState.bench : null;
  // Panel path uses in-memory values — no async fetch, so never "loading".
  const variantLoading = !activeMetricPanel && hasDims && variantState?.key !== dimKey;

  // The bench whose numbers the preview and the provider list reflect.
  // Priority: active panel (uses in-memory values from benchmark prop,
  // no extra fetch) > fetched dim variant > base aggregate.
  // Null while a dim variant is still in flight (panel path is instant).
  const effectiveBench = (() => {
    if (activeMetricPanel) {
      return {
        ...benchmark,
        metric: activeMetricPanel.label,
        unit: (activeMetricPanel.unit ?? benchmark.unit) as Benchmark["unit"],
        higherIsBetter:
          activeMetricPanel.higherIsBetter ?? benchmark.higherIsBetter,
        results: benchmark.results
          .filter(
            (r) =>
              activeMetricPanel.values[r.slug] != null &&
              Number.isFinite(activeMetricPanel.values[r.slug]),
          )
          .map((r) => ({
            ...r,
            ms: { ...r.ms, p50: activeMetricPanel.values[r.slug] },
          })),
      };
    }
    if (hasDims) return variant;
    return benchmark;
  })();

  // Live rows ranked by headline value (video order), dead rows last.
  const rankedResults = useMemo(() => {
    if (!effectiveBench) return [];
    const cmp = (a: Benchmark["results"][number], b: Benchmark["results"][number]) =>
      effectiveBench.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50;
    const live = effectiveBench.results.filter(hasData).sort(cmp);
    const dead = effectiveBench.results.filter((r) => !hasData(r));
    return [...live, ...dead];
  }, [effectiveBench]);

  // Selection. Default = the view's top 8 live providers (each composition
  // only shows ~8 bars and rendering 50+ providers per frame on a 2-vCPU
  // box blows past the Vercel function ceiling; power users can click
  // "All"). A user override is stored WITH the bench it was made against,
  // so a variant swap falls back to the new view's default automatically:
  // a selection carried across views could name providers that have no
  // data in the new one.
  const defaultSelection = useMemo(
    () => new Set(rankedResults.filter(hasData).slice(0, 8).map((r) => r.slug)),
    [rankedResults],
  );
  const [selOverride, setSelOverride] = useState<{
    bench: Benchmark | null;
    sel: Set<string>;
  } | null>(null);
  const selected =
    selOverride && selOverride.bench === effectiveBench
      ? selOverride.sel
      : defaultSelection;
  const setSelected = (sel: Set<string>) =>
    setSelOverride({ bench: effectiveBench, sel });
  const toggleProvider = (s: string) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSelected(next);
  };

  // Exact title the video will display: the bench title plus the human
  // labels of the active filters and panel, e.g. "RPC capabilities (Ethereum, EU West)"
  // or "Hyperliquid frontends (Volume routed)". Injected into the render payload.
  const videoTitle = useMemo(() => {
    const parts = activeDims.map((d) => d.label);
    if (activeMetricPanel) parts.push(activeMetricPanel.label);
    return parts.length > 0
      ? `${benchmark.title} (${parts.join(", ")})`
      : benchmark.title;
  }, [benchmark.title, activeDims, activeMetricPanel]);

  // Row list for the picker, ranked order, dead rows flagged.
  const providers = useMemo(
    () =>
      rankedResults.map((r) => ({
        slug: r.slug,
        name: r.name,
        live: hasData(r),
      })),
    [rankedResults],
  );
  const liveCount = providers.filter((p) => p.live).length;

  // Preview rows: video rank (position among the selected live rows,
  // which IS the order the race renders), live flag, inclusion flag.
  const previewRows = useMemo(() => {
    let rank = 0;
    return rankedResults.map((r) => {
      const live = hasData(r);
      const on = live && selected.has(r.slug);
      return { r, live, on, rank: on ? ++rank : null };
    });
  }, [rankedResults, selected]);

  const onRender = async () => {
    if (selected.size === 0) {
      setState({ status: "error", message: "Pick at least one provider" });
      return;
    }
    try {
      setState({ status: "loading_series" });
      // Same dims the preview shows; the series route validates and
      // canonicalizes them exactly like the variant route did for the
      // preview values. Title override: the renderer displays whatever
      // the payload carries, so the parenthetical filter labels ride in
      // here and the cache keys the variant separately for free.
      const full: BenchPayload = await fetchBenchSeries(slug, range, {
        chain: dims.chain,
        region: dims.region,
        kind: dims.kind,
        venue: dims.venue,
        panel: panelId ?? undefined,
      });
      const filtered: BenchPayload = {
        ...full,
        title: videoTitle,
        providers: full.providers.filter((p) => selected.has(p.slug)),
      };
      if (filtered.providers.length === 0) {
        throw new Error("No data for the selected providers in this range");
      }

      setState({ status: "rendering", startedAt: Date.now() });
      const res = await fetch("/api/video/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetId: slug,
          viewId: view,
          raceSeconds,
          skipIntro,
          format,
          audio,
          beats,
          bench: filtered,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Render failed (${res.status})`);
      }
      const data = (await res.json()) as {
        url: string;
        cached?: boolean;
        ms?: number;
      };
      setState({
        status: "done",
        url: data.url,
        cached: !!data.cached,
        ms: data.ms ?? 0,
      });
    } catch (e) {
      setState({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onCopy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const tweetIntent = (url: string) =>
    `https://x.com/intent/tweet?text=${encodeURIComponent(`${videoTitle} · last ${range}`)}&url=${encodeURIComponent(url)}`;

  const isBusy =
    state.status === "loading_series" || state.status === "rendering";
  // Nothing to render: the variant has no live providers (or every one
  // was deselected). Disable the button instead of letting the POST fail.
  const emptySelection = !variantLoading && liveCount === 0;
  const canRender = !isBusy && !variantLoading && !emptySelection && selected.size > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl rounded-md border border-rule bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-4 sm:px-6 py-4">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
            Export video · {videoTitle}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-ink-muted hover:text-ink transition-colors"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-6">
          {/* Range */}
          <div>
            <Label>Range</Label>
            <Segment>
              {RANGE_IDS.map((id) => (
                <SegmentButton
                  key={id}
                  active={range === id}
                  onClick={() => setRange(id)}
                  disabled={isBusy}
                >
                  {RANGE_LABEL[id]}
                </SegmentButton>
              ))}
            </Segment>
          </div>

          {/* View */}
          <div>
            <Label>View</Label>
            <Segment>
              {VIEW_IDS.map((id) => (
                <SegmentButton
                  key={id}
                  active={view === id}
                  onClick={() => setView(id)}
                  disabled={isBusy}
                >
                  {VIEW_LABEL[id]}
                </SegmentButton>
              ))}
            </Segment>
          </div>

          {/* Metric panel picker. Shown for benches with companion metrics
              (e.g. hyperliquid-frontends: Revenue / Volume / Users / ...). */}
          {panelOptions.length > 0 && (
            <div role="group" aria-label="Select metric">
              <Label>Metric</Label>
              <div className="inline-flex flex-wrap gap-1 rounded-md border border-rule p-1 bg-paper-2">
                <SegmentButton
                  active={!panelId}
                  onClick={() => setPanelId(null)}
                  disabled={isBusy}
                >
                  {benchmark.panelMainLabel ?? benchmark.metric}
                </SegmentButton>
                {panelOptions.map((o) => (
                  <SegmentButton
                    key={o.value}
                    active={panelId === o.value}
                    onClick={() => setPanelId(o.value)}
                    disabled={isBusy}
                  >
                    {o.label}
                  </SegmentButton>
                ))}
              </div>
            </div>
          )}

          {/* Dimension filters: one pill row per dimension the bench
              declares. Mirrors the tab pickers on the bench page. */}
          {DIM_IDS.filter((dim) => dimOptions[dim]).map((dim) => (
            <div key={dim} role="group" aria-label={`Filter by ${DIM_LABEL[dim].toLowerCase()}`}>
              <Label>{DIM_LABEL[dim]}</Label>
              <div className="inline-flex flex-wrap gap-1 rounded-md border border-rule p-1 bg-paper-2">
                <SegmentButton
                  active={!dims[dim] || dims[dim] === "all"}
                  onClick={() => setDim(dim, null)}
                  disabled={isBusy}
                >
                  All
                </SegmentButton>
                {dimOptions[dim]!.map((o) => (
                  <SegmentButton
                    key={o.value}
                    active={dims[dim] === o.value}
                    onClick={() => setDim(dim, o.value)}
                    disabled={isBusy}
                  >
                    {o.label}
                  </SegmentButton>
                ))}
              </div>
            </div>
          ))}

          {/* Format */}
          <div>
            <Label>Format</Label>
            <Segment>
              <SegmentButton
                active={format === "landscape"}
                onClick={() => setFormat("landscape")}
                disabled={isBusy}
              >
                Landscape 16:9
              </SegmentButton>
              <SegmentButton
                active={format === "short"}
                onClick={() => setFormat("short")}
                disabled={isBusy}
              >
                Short 9:16
              </SegmentButton>
            </Segment>
          </div>

          {/* Race duration slider */}
          <div>
            <Label>
              Race duration · <em className="not-italic font-mono">{raceSeconds}s</em>
            </Label>
            <input
              type="range"
              min={5}
              max={60}
              step={1}
              value={raceSeconds}
              onChange={(e) => setRaceSeconds(Number(e.target.value))}
              aria-label="Race duration in seconds"
              disabled={isBusy}
              className="w-full accent-ink"
            />
            <div className="flex justify-between text-[10px] tabular-nums text-ink-faint">
              <span>5s</span>
              <span>15s</span>
              <span>30s</span>
              <span>45s</span>
              <span>60s</span>
            </div>
            <label className="mt-3 inline-flex items-center gap-2 text-[11px] text-ink-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipIntro}
                onChange={(e) => setSkipIntro(e.target.checked)}
                disabled={isBusy}
                className="accent-ink h-3.5 w-3.5"
              />
              Skip 3s OpenChainBench intro
            </label>
            <label className="mt-2 ml-4 inline-flex items-center gap-2 text-[11px] text-ink-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={audio}
                onChange={(e) => setAudio(e.target.checked)}
                disabled={isBusy}
                className="accent-ink h-3.5 w-3.5"
              />
              Ambient soundtrack (fades out at the end)
            </label>
            <label className="mt-2 ml-4 inline-flex items-center gap-2 text-[11px] text-ink-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={beats}
                onChange={(e) => setBeats(e.target.checked)}
                disabled={isBusy}
                className="accent-ink h-3.5 w-3.5"
              />
              Story beats: lead-change callouts (beta)
            </label>
          </div>

          {/* Preview: exactly the names, values and order the video will
              render. Rows toggle inclusion; rows without data in the
              current view are muted and cannot be included. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>
                In this video <em className="not-italic text-ink-faint normal-case tracking-normal">· {selected.size}/{liveCount} providers{selected.size > 12 && " · render will be slow"}</em>
              </Label>
              <div className="flex items-center gap-2">
                {variantLoading && (
                  <Loader2
                    size={12}
                    strokeWidth={2}
                    className="animate-spin text-ink-muted"
                    aria-label="Loading filtered data"
                  />
                )}
                <SmallLink
                  onClick={() =>
                    setSelected(
                      new Set(providers.filter((p) => p.live).map((p) => p.slug)),
                    )
                  }
                  disabled={isBusy}
                >
                  All
                </SmallLink>
                <SmallLink onClick={() => setSelected(new Set())} disabled={isBusy}>
                  None
                </SmallLink>
              </div>
            </div>
            <div className="rounded-md border border-rule overflow-hidden">
              <div className="flex items-baseline justify-between gap-3 border-b border-rule bg-paper-2 px-3 py-2">
                <span className="font-serif text-[13px] text-ink truncate">{videoTitle}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                  {RANGE_LABEL[range]}
                </span>
              </div>
              {variantLoading ? (
                <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-ink-muted">
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                  Loading data for this selection
                </div>
              ) : previewRows.length === 0 ? (
                <div className="px-3 py-6 text-[11px] text-ink-muted">
                  No providers report data for this selection.
                </div>
              ) : (
                <ul className="max-h-72 overflow-y-auto divide-y divide-rule">
                  {previewRows.map(({ r, live, on, rank }) => {
                    const isLeader = rank === 1;
                    return (
                      <li key={r.slug}>
                        <button
                          type="button"
                          onClick={() => live && toggleProvider(r.slug)}
                          disabled={isBusy || !live}
                          aria-pressed={on}
                          aria-label={
                            live
                              ? `${on ? "Exclude" : "Include"} ${r.name}`
                              : `${r.name}: no data in this view`
                          }
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                            !live
                              ? "opacity-45 cursor-not-allowed"
                              : on
                                ? "hover:bg-paper-soft/50"
                                : "opacity-55 hover:opacity-100"
                          } ${isLeader ? "bg-paper-2" : ""}`}
                        >
                          <span
                            aria-hidden
                            className={`h-3.5 w-3.5 shrink-0 rounded-[3px] border flex items-center justify-center ${
                              !live
                                ? "invisible"
                                : on
                                  ? "border-ink bg-ink text-paper"
                                  : "border-rule text-transparent"
                            }`}
                          >
                            <Check size={10} strokeWidth={3} />
                          </span>
                          <span className="w-6 shrink-0 text-[11px] tabular-nums text-ink-muted">
                            {rank ? String(rank).padStart(2, "0") : ""}
                          </span>
                          <ProviderLogo slug={r.slug} name={r.name} size={20} />
                          <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-ink">
                            {r.name}
                          </span>
                          {live ? (
                            <span
                              className={`shrink-0 text-[12px] tabular-nums ${
                                isLeader ? "font-semibold text-ink" : "text-ink-muted"
                              }`}
                            >
                              {fmtUnit(r.ms.p50, effectiveBench?.unit ?? benchmark.unit)}
                            </span>
                          ) : (
                            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                              no data
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Action row */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onRender}
              disabled={!canRender}
              className="inline-flex items-center gap-2 rounded-md border border-ink bg-ink px-4 py-2.5 text-[12px] font-medium uppercase tracking-[0.18em] text-paper hover:bg-paper hover:text-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBusy ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <Video size={14} strokeWidth={2} />
              )}
              {state.status === "loading_series"
                ? "Loading data…"
                : state.status === "rendering"
                  ? "Rendering…"
                  : "Generate MP4"}
            </button>
            {state.status === "rendering" && (
              <span className="text-[11px] text-ink-muted">~10-30s first run · instant on rerun</span>
            )}
            {emptySelection && state.status === "idle" && (
              <span className="text-[11px] text-ink-muted">
                No providers report data for this selection. Pick another filter combination.
              </span>
            )}
            {!emptySelection && selected.size === 0 && state.status === "idle" && (
              <span className="text-[11px] text-ink-muted">
                Include at least one provider.
              </span>
            )}
            {state.status === "error" && (
              <span className="text-[11px] text-red-500">{state.message}</span>
            )}
          </div>

          {/* Render result */}
          {state.status === "done" && (
            <div className="rounded-md border border-rule bg-paper-2 p-3 space-y-3">
              <div className="flex items-center justify-between text-[11px] text-ink-muted">
                <span>
                  Render ready
                  {state.cached && (
                    <em className="ml-2 not-italic text-green-600">· cache hit</em>
                  )}
                  {!state.cached && state.ms > 0 && (
                    <em className="ml-2 not-italic">· {(state.ms / 1000).toFixed(1)}s</em>
                  )}
                </span>
              </div>
              <video
                src={state.url}
                autoPlay
                loop
                muted
                playsInline
                controls
                className={
                  format === "short"
                    ? "rounded-md bg-black object-contain aspect-[9/16] max-h-[60vh] mx-auto"
                    : "w-full rounded-md bg-black object-contain aspect-video"
                }
              />
              <div className="flex flex-wrap gap-2">
                <a
                  href={state.url}
                  download
                  className="inline-flex items-center gap-2 rounded-md border border-ink px-3 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink hover:bg-ink hover:text-paper transition-colors"
                >
                  <Download size={14} strokeWidth={2} /> MP4
                </a>
                <a
                  href={tweetIntent(state.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-2 rounded-md border border-ink px-3 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink hover:bg-ink hover:text-paper transition-colors"
                >
                  <Share2 size={14} strokeWidth={2} /> Share on X
                </a>
                <button
                  type="button"
                  onClick={() => onCopy(state.url)}
                  className="inline-flex items-center gap-2 rounded-md border border-ink px-3 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink hover:bg-ink hover:text-paper transition-colors"
                >
                  <Copy size={14} strokeWidth={2} />
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
      {children}
    </div>
  );
}

function Segment({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex gap-1 rounded-md border border-rule p-1 bg-paper-2">
      {children}
    </div>
  );
}

function SegmentButton({
  children,
  active,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        active
          ? "bg-ink text-paper"
          : "text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function SmallLink({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[10px] uppercase tracking-[0.18em] text-ink-muted hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}
