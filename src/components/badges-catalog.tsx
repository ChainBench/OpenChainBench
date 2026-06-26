"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Loader2, Search, X } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { ProviderLogo } from "@/components/provider-logo";

/**
 * Public discovery surface for the per-(benchmark, provider) badge SVGs
 * already served from /api/badge/<bench>/<provider>. Renders a filterable
 * grid of cards and an embed-snippet modal with optional chain / region
 * scope controls when the parent bench declares those dimensions.
 *
 * Server hands in the flat list of pairs so the search index is a single
 * prerendered array; the snippet payload for each (pair, format, scope)
 * is fetched on demand from the existing /snippet?format= route so a
 * change of scope in the modal is one network call, not a page rebuild.
 */

export type BadgePair = {
  benchSlug: string;
  benchTitle: string;
  benchCategory: string;
  providerSlug: string;
  providerName: string;
  /** Live rank position (1-indexed) on the unfiltered ranking. */
  rank: number;
  /** Number of live providers ranked on this bench. */
  total: number;
  /** Optional scope dimensions surfaced by the modal as dropdowns. */
  dimensions?: {
    chain?: { value: string; label: string }[];
    region?: { value: string; label: string }[];
  };
};

type Format = "markdown" | "html" | "url" | "json";

const FORMATS: { id: Format; label: string }[] = [
  { id: "markdown", label: "Markdown" },
  { id: "html", label: "HTML" },
  { id: "url", label: "URL" },
  { id: "json", label: "JSON" },
];

export function BadgesCatalog({ pairs }: { pairs: BadgePair[] }) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [open, setOpen] = useState<BadgePair | null>(null);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const p of pairs) {
      if (!seen.has(p.benchCategory)) {
        seen.add(p.benchCategory);
        list.push(p.benchCategory);
      }
    }
    return list.sort();
  }, [pairs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pairs.filter((p) => {
      if (activeCategory && p.benchCategory !== activeCategory) return false;
      if (!q) return true;
      return (
        p.providerName.toLowerCase().includes(q) ||
        p.providerSlug.toLowerCase().includes(q) ||
        p.benchTitle.toLowerCase().includes(q) ||
        p.benchSlug.toLowerCase().includes(q)
      );
    });
  }, [pairs, query, activeCategory]);

  return (
    <div>
      {/* Filter bar */}
      <div className="mb-8 flex flex-col gap-4">
        <ul className="-mx-4 px-4 sm:mx-0 sm:px-0 flex flex-nowrap sm:flex-wrap items-center gap-2 overflow-x-auto sm:overflow-visible [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <li>
            <button
              type="button"
              className="pill"
              data-active={activeCategory === null}
              onClick={() => setActiveCategory(null)}
            >
              All
            </button>
          </li>
          {categories.map((c) => (
            <li key={c}>
              <button
                type="button"
                className="pill"
                data-active={activeCategory === c}
                onClick={() =>
                  setActiveCategory(activeCategory === c ? null : c)
                }
              >
                {c}
              </button>
            </li>
          ))}
        </ul>

        <label className="group relative flex items-center w-full sm:max-w-sm">
          <Search
            size={13}
            strokeWidth={2}
            className="absolute left-3 text-ink-faint group-focus-within:text-ink-muted pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search provider or benchmark"
            className="w-full pl-8 pr-3 py-2 text-sm bg-surface border border-rule rounded-md focus:outline-none focus:border-ink/40 placeholder:text-ink-faint transition-colors"
          />
        </label>

        <p className="label-mono text-ink-faint">
          {filtered.length} {filtered.length === 1 ? "badge" : "badges"}{" "}
          available
        </p>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-ink-muted">
            No badge matches that search.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <li key={`${p.benchSlug}|${p.providerSlug}`}>
              <BadgeCard pair={p} onOpen={() => setOpen(p)} />
            </li>
          ))}
        </ul>
      )}

      {open && (
        <EmbedModal pair={open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function BadgeCard({
  pair,
  onOpen,
}: {
  pair: BadgePair;
  onOpen: () => void;
}) {
  const badgeUrl = `/api/badge/${pair.benchSlug}/${pair.providerSlug}`;
  return (
    <div className="card-soft p-5 flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderLogo
            slug={pair.providerSlug}
            name={pair.providerName}
            size={24}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate">
              {pair.providerName}
            </p>
            <p className="label-mono text-ink-faint truncate">
              {pair.benchCategory}
            </p>
          </div>
        </div>
        <span
          className="label-mono shrink-0 px-1.5 py-0.5 rounded border border-rule text-ink-muted tabular"
          title={`Ranked ${pair.rank} of ${pair.total}`}
        >
          #{pair.rank}/{pair.total}
        </span>
      </div>

      <p className="text-[13px] text-ink-soft leading-snug line-clamp-2 min-h-[36px]">
        {pair.benchTitle}
      </p>

      <div className="rounded border border-rule bg-paper-soft p-2 flex items-center justify-center min-h-[60px] overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={badgeUrl}
          alt={`Live badge for ${pair.providerName} on ${pair.benchTitle}`}
          loading="lazy"
          decoding="async"
          className="max-w-full h-auto"
        />
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-auto inline-flex items-center justify-center gap-1.5 self-start rounded border border-rule px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-ink-muted hover:text-ink hover:border-ink transition-colors font-medium"
      >
        <Code2 size={12} strokeWidth={2} />
        Get embed code
      </button>
    </div>
  );
}

function EmbedModal({
  pair,
  onClose,
}: {
  pair: BadgePair;
  onClose: () => void;
}) {
  const [active, setActive] = useState<Format>("markdown");
  const [chain, setChain] = useState<string>("");
  const [region, setRegion] = useState<string>("");
  const [snippets, setSnippets] = useState<Record<Format, string> | null>(null);
  const [badgeUrl, setBadgeUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const chainDims = (pair.dimensions?.chain ?? []).filter(
    (c) => c.value.toLowerCase() !== "all",
  );
  const regionDims = (pair.dimensions?.region ?? []).filter(
    (r) => r.value.toLowerCase() !== "all",
  );

  const scopeQs = useMemo(() => {
    const qs = new URLSearchParams();
    if (chain) qs.set("chain", chain);
    if (region) qs.set("region", region);
    return qs.toString();
  }, [chain, region]);

  // Reset cached payload during render when the fetch identity changes
  // instead of dispatching setState inside the effect body (which trips
  // `react-hooks/set-state-in-effect`). The fetch itself still runs in
  // the effect below.
  const fetchKey = `${pair.benchSlug}|${pair.providerSlug}|${scopeQs}`;
  const [prevFetchKey, setPrevFetchKey] = useState(fetchKey);
  if (prevFetchKey !== fetchKey) {
    setPrevFetchKey(fetchKey);
    setSnippets(null);
    setBadgeUrl(null);
    setError(false);
  }

  // Refetch all four formats whenever the pair or scope changes. Four
  // parallel calls hit the CDN-cached snippet route; first paint usually
  // arrives within a single network round-trip.
  useEffect(() => {
    let cancelled = false;
    const base = `/api/badge/${pair.benchSlug}/${pair.providerSlug}/snippet`;
    const suffix = scopeQs ? `&${scopeQs}` : "";
    Promise.all([
      fetch(`${base}?format=json${suffix}`).then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`json ${r.status}`)),
      ),
      fetch(`${base}?format=markdown${suffix}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`md ${r.status}`)),
      ),
      fetch(`${base}?format=html${suffix}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`html ${r.status}`)),
      ),
      fetch(`${base}?format=url${suffix}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`url ${r.status}`)),
      ),
    ])
      .then(([jsonPayload, markdown, html, url]) => {
        if (cancelled) return;
        setSnippets({
          markdown: markdown.trim(),
          html: html.trim(),
          url: url.trim(),
          json: JSON.stringify(jsonPayload, null, 2),
        });
        setBadgeUrl(
          typeof jsonPayload?.badge_url === "string"
            ? jsonPayload.badge_url
            : null,
        );
      })
      .catch((err) => {
        if (cancelled) return;
        if (process.env.NODE_ENV !== "production") {
          console.debug("[badges-catalog] snippet fetch failed", err);
        }
        setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [pair.benchSlug, pair.providerSlug, scopeQs]);

  // Esc to close + body scroll lock + focus management.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);

    const focusTimer = window.setTimeout(() => {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      focusables?.[0]?.focus();
    }, 0);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusTimer);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const ariaLabel = `Embed badge for ${pair.providerName} on ${pair.benchTitle}`;
  const currentSnippet = snippets?.[active] ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="card-soft relative w-full max-w-2xl rounded-md border border-rule bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-4 sm:px-5 py-3">
          <div className="min-w-0">
            <p className="label-mono text-ink-faint">Embed badge</p>
            <p className="mt-0.5 text-[13px] font-medium text-ink truncate">
              {pair.providerName} on {pair.benchTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-muted hover:text-ink transition-colors shrink-0 ml-3"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="px-4 sm:px-5 py-4 space-y-4">
          {/* Live preview */}
          <div className="rounded border border-rule bg-paper-soft p-3 flex items-center justify-center min-h-[68px]">
            {badgeUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={badgeUrl}
                alt={`Live badge for ${pair.providerName} on ${pair.benchTitle}`}
                className="max-w-full h-auto"
              />
            ) : error ? (
              <span className="text-[11px] text-ink-muted">
                Could not load the badge preview.
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 text-[11px] text-ink-muted">
                <Loader2 size={14} className="animate-spin" />
                Loading badge
              </span>
            )}
          </div>

          {/* Optional scope controls */}
          {(chainDims.length > 0 || regionDims.length > 0) && (
            <div className="flex flex-wrap gap-3">
              {chainDims.length > 0 && (
                <ScopeSelect
                  label="Chain"
                  value={chain}
                  onChange={setChain}
                  options={chainDims}
                />
              )}
              {regionDims.length > 0 && (
                <ScopeSelect
                  label="Region"
                  value={region}
                  onChange={setRegion}
                  options={regionDims}
                />
              )}
            </div>
          )}

          {/* Format tabs */}
          <div
            role="tablist"
            aria-label="Snippet format"
            className="flex flex-wrap items-center gap-1 border border-rule rounded p-1 bg-paper-soft w-fit"
          >
            {FORMATS.map((f) => (
              <button
                key={f.id}
                role="tab"
                type="button"
                aria-selected={active === f.id}
                onClick={() => setActive(f.id)}
                className={`label-mono px-2.5 py-1 rounded transition-colors ${
                  active === f.id
                    ? "bg-paper text-ink shadow-sm"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Snippet */}
          <div className="space-y-2">
            <textarea
              readOnly
              value={
                error
                  ? "Failed to load snippet."
                  : (currentSnippet || "Loading…")
              }
              rows={active === "json" ? 10 : 4}
              aria-label={`${active.toUpperCase()} snippet`}
              className="w-full font-mono text-[11px] bg-paper-soft border border-rule rounded p-3 resize-none text-ink whitespace-pre overflow-x-auto"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex items-center justify-end">
              <CopyButton
                value={currentSnippet}
                label={`Copy ${active}`}
              />
            </div>
          </div>

          <p className="text-[11px] text-ink-muted leading-relaxed border-t border-rule pt-3">
            Free to embed under CC-BY-4.0. Badge auto-refreshes every five
            minutes from openchainbench.com.
          </p>
        </div>
      </div>
    </div>
  );
}

function ScopeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
      <span className="label-mono text-ink-faint">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface border border-rule rounded px-2 py-1.5 text-sm text-ink focus:outline-none focus:border-ink/40"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
