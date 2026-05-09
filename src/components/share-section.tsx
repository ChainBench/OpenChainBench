"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Image as ImageIcon, Loader2, X } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";

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

  const activeTemplate = TEMPLATES.find((t) => t.id === activeId);

  // Build the URL with the right params per template.
  const cardSrc = (templateId: string) => {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    const chainParam = chain ? `&chain=${encodeURIComponent(chain)}` : "";
    const base = `/benchmarks/${slug}/share-card?template=${templateId}${chainParam}`;
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
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-ink bg-ink px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-paper hover:bg-paper hover:text-ink transition-colors shadow-sm"
      >
        <ImageIcon size={14} strokeWidth={2} />
        Export as image
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-4xl rounded-md border border-rule bg-paper shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rule px-6 py-4">
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
      <div className="px-6 py-5 space-y-5">
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

/** Preview frame with a "Generating preview…" overlay while the PNG loads. */
function SharePreview({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

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
