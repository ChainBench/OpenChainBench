"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Video, X, Loader2, Download, Copy, Share2 } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { EXPORT_VIDEO_ENABLED } from "@/lib/export-video/config";
import { fetchBenchSeries } from "@/lib/export-video/fetch-series";
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Export video"
        title="Export video"
        className="inline-flex items-center justify-center rounded-md border border-ink bg-ink p-2.5 text-paper hover:bg-paper hover:text-ink transition-colors shadow-sm"
      >
        <Video size={14} strokeWidth={2} />
      </button>

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
  title,
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
  // Default to the top 8 providers (sorted by p50). Each composition only
  // shows ~8 visible anyway (BarChartRace.VISIBLE_BARS = 8) and rendering
  // 50+ providers per frame on a 2-vCPU box pushes us past 2 minutes —
  // outside the Vercel function ceiling. Power users can click "All".
  const [selected, setSelected] = useState<Set<string>>(() => {
    const sorted = [...benchmark.results].sort((a, b) =>
      benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
    );
    return new Set(sorted.slice(0, 8).map((r) => r.slug));
  });
  const [state, setState] = useState<RenderState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  // Sort the provider list by p50 so the leader sits at the top of the
  // multi-select (same order share-section.tsx uses).
  const providers = useMemo(
    () =>
      [...benchmark.results]
        .sort((a, b) =>
          benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
        )
        .map((r) => ({ slug: r.slug, name: r.name })),
    [benchmark],
  );

  const toggleProvider = (s: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  // Mirror the bench page's URL filters — chain=ethereum or region=eu-west
  // — so a video exported from a chain-scoped tab uses the chain-scoped
  // series rather than the (often empty) global view.
  const searchParams = useSearchParams();
  const chain = searchParams.get("chain");
  const region = searchParams.get("region");

  const onRender = async () => {
    if (selected.size === 0) {
      setState({ status: "error", message: "Pick at least one provider" });
      return;
    }
    try {
      setState({ status: "loading_series" });
      const full: BenchPayload = await fetchBenchSeries(slug, range, { chain, region });
      const filtered: BenchPayload = {
        ...full,
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
    `https://x.com/intent/tweet?text=${encodeURIComponent(`${title} · last ${range}`)}&url=${encodeURIComponent(url)}`;

  const isBusy =
    state.status === "loading_series" || state.status === "rendering";

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
            Export video · {benchmark.title}
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
          </div>

          {/* Providers */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>
                Providers <em className="not-italic text-ink-faint normal-case tracking-normal">· {selected.size}/{providers.length} selected{selected.size > 12 && " · render will be slow"}</em>
              </Label>
              <div className="flex gap-2">
                <SmallLink
                  onClick={() => setSelected(new Set(providers.map((p) => p.slug)))}
                  disabled={isBusy}
                >
                  All
                </SmallLink>
                <SmallLink onClick={() => setSelected(new Set())} disabled={isBusy}>
                  None
                </SmallLink>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {providers.map((p) => {
                const on = selected.has(p.slug);
                return (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => toggleProvider(p.slug)}
                    disabled={isBusy}
                    className={`px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors ${
                      on
                        ? "border-ink bg-ink text-paper"
                        : "border-rule bg-paper text-ink-muted hover:text-ink hover:border-ink"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action row */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onRender}
              disabled={isBusy}
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
