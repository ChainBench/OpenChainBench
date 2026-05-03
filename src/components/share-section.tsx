"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, ChevronDown, Loader2 } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";

type Template = {
  id: string;
  label: string;
  description: string;
  /** Whether this template lets the reader filter providers. */
  filterable: boolean;
};

const TEMPLATES: Template[] = [
  {
    id: "ranking",
    label: "Ranking",
    description: "Vertical bars sorted ascending by p50, with provider names and p99 tails.",
    filterable: false,
  },
  {
    id: "leaderboard",
    label: "Leaderboard",
    description: "Ranked rows with horizontal mini-bars in each provider's signature color.",
    filterable: false,
  },
  {
    id: "snapshot",
    label: "Snapshot",
    description: "Full 24-hour multi-line chart with per-provider legend at the bottom.",
    filterable: true,
  },
  {
    id: "headline",
    label: "Headline",
    description: "Big-number poster — the field's fastest p50 in the winner's color.",
    filterable: true,
  },
  {
    id: "compare",
    label: "Compare",
    description: "Top-2 head-to-head with p50 / p99 / success / sample-size and the delta between them.",
    filterable: true,
  },
];

type Props = {
  slug: string;
  title: string;
  benchmark: Benchmark;
};

export function ShareSection({ slug, title, benchmark }: Props) {
  const [activeId, setActiveId] = useState<string>("ranking");

  // Sort providers ascending p50 for the toggle UI — same order as the
  // legend / ledger.
  const orderedProviders = useMemo(
    () =>
      [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50).map((r) => ({
        slug: r.slug,
        name: r.name,
      })),
    [benchmark]
  );

  // Default: all providers selected.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(orderedProviders.map((p) => p.slug))
  );

  function toggleProvider(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  const activeTemplate = TEMPLATES.find((t) => t.id === activeId);
  const showFilter = activeTemplate?.filterable ?? false;

  // Build the URL with optional providers filter.
  const cardSrc = (templateId: string, applyFilter: boolean) => {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    const base = `/benchmarks/${slug}/share-card?template=${templateId}`;
    if (!applyFilter || !tpl?.filterable) return base;
    if (selected.size === orderedProviders.length) return base; // all selected ⇒ no param
    if (selected.size === 0) return base; // nothing selected ⇒ no param (server falls back)
    const list = orderedProviders
      .filter((p) => selected.has(p.slug))
      .map((p) => p.slug)
      .join(",");
    return `${base}&providers=${encodeURIComponent(list)}`;
  };

  async function handleDownload(templateId: string) {
    const url = cardSrc(templateId, true);
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
    <details className="mt-1 group border-t border-rule">
      <summary className="flex cursor-pointer items-center justify-between py-4 list-none">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
          Share · export · embed
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          className="text-ink-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="pb-6 space-y-5">
        <p className="text-sm text-ink-muted leading-relaxed max-w-2xl">
          Pick a layout and download a 1200×630 PNG ready for Twitter, Reddit, LinkedIn or any OG-card embed. Same data, same colors as this dashboard.
        </p>

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

        {/* Active preview */}
        {TEMPLATES.map((t) => {
          if (t.id !== activeId) return null;
          return (
            <div key={t.id} className="space-y-3">
              <p className="text-xs text-ink-muted">{t.description}</p>

              {/* Provider filter (only on filterable templates) */}
              {showFilter && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint mr-1">
                    Providers
                  </span>
                  {orderedProviders.map((p) => {
                    const isOn = selected.has(p.slug);
                    return (
                      <button
                        key={p.slug}
                        onClick={() => toggleProvider(p.slug)}
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
                      setSelected(new Set(orderedProviders.map((p) => p.slug)))
                    }
                    className="ml-1 text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink lnk"
                  >
                    Reset
                  </button>
                </div>
              )}

              <SharePreview
                key={cardSrc(t.id, true)}
                src={cardSrc(t.id, true)}
                alt={`${title} — ${t.label} share card`}
              />

              {showFilter && (
                <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                  Showing {selected.size} of {orderedProviders.length} providers
                  {selected.size === 0 && " · empty selection falls back to all"}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => handleDownload(t.id)}
                  className="btn-primary btn-primary--sm inline-flex items-center gap-1.5"
                >
                  <Download size={14} strokeWidth={2.2} />
                  Download PNG
                </button>
                <a
                  href={cardSrc(t.id, true)}
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
    </details>
  );
}

/** Preview frame with a "Generating preview…" overlay while the PNG loads. */
function SharePreview({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // Reset loaded state when src changes (template or filter change).
  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [src]);

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
