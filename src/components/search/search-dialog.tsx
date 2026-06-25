"use client";

import { Command } from "cmdk";
import Fuse from "fuse.js";
import {
  ArrowRight,
  Building2,
  FileText,
  GitCompareArrows,
  HelpCircle,
  Layers,
  Link2,
  Search,
  Trophy,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "@/components/search/search-provider";
import { useRecentSearches, type RecentEntry } from "@/components/search/use-recent-searches";
import { ProviderLogo } from "@/components/provider-logo";
import type { SearchItem, SearchKind } from "@/lib/search/types";

const KIND_ORDER: SearchKind[] = [
  "Benchmark",
  "Product",
  "Compare",
  "Alternative",
  "Answer",
  "Chain",
  "Page",
];

const KIND_LABEL: Record<SearchKind, string> = {
  Benchmark: "Benchmarks",
  Product: "Products",
  Compare: "Compare",
  Alternative: "Alternatives",
  Answer: "Answers",
  Chain: "Chains",
  Page: "Pages",
};

const KIND_SINGULAR: Record<SearchKind, string> = {
  Benchmark: "Bench",
  Product: "Product",
  Compare: "vs",
  Alternative: "Alt",
  Answer: "Answer",
  Chain: "Chain",
  Page: "Page",
};

const KIND_ICON: Record<SearchKind, typeof Search> = {
  Benchmark: Trophy,
  Product: Building2,
  Compare: GitCompareArrows,
  Alternative: Layers,
  Answer: HelpCircle,
  Chain: Link2,
  Page: FileText,
};

/**
 * The featured + trending lists themselves now live in
 * `src/lib/search-featured.ts` (single source of truth used by the cron
 * that warms the KV blob and by the public endpoint that serves it).
 * The dialog consumes the pre-resolved blob from SearchProvider, which
 * fetches `/api/search/featured` at mount + on trigger hover.
 */
import type { FeaturedCardData } from "@/lib/search-featured";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded border border-rule bg-paper-soft text-[10px] font-medium text-ink-muted font-mono">
      {children}
    </kbd>
  );
}

function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-4 pb-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </span>
      {action}
    </div>
  );
}

function KindIcon({ kind, size = 14 }: { kind: SearchKind; size?: number }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={size} aria-hidden className="text-ink-faint shrink-0" />;
}

function fmtUnit(value: number | null | undefined, unit: string): string {
  if (value == null) return "—";
  if (unit === "ms") {
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${(value / 1000).toFixed(2)} s`;
  }
  if (unit === "s" || unit === "sec") return `${value.toFixed(2)} s`;
  if (unit === "pct") return `${value.toFixed(1)}%`;
  if (unit === "bps" || unit === "bp") return `${value.toFixed(1)} bp`;
  if (unit === "usd") {
    if (value > 1e9) return `$${(value / 1e9).toFixed(1)}B`;
    if (value > 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (value > 1e3) return `$${(value / 1e3).toFixed(1)}k`;
    return `$${value.toFixed(0)}`;
  }
  if (unit === "count") return value.toLocaleString();
  return String(value);
}

export default function SearchDialog() {
  const { items, close: onClose, featured: featuredBlob } = useSearch();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isClosing, setIsClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { recent, push: pushRecent, remove: removeRecent, clear: clearRecent } =
    useRecentSearches();

  // One Fuse instance per dialog mount. The full corpus is ~400 docs
  // so build cost is sub-millisecond, no need to memoise across mounts.
  const fuse = useMemo(
    () =>
      new Fuse(items, {
        keys: [
          { name: "title", weight: 0.6 },
          { name: "tags", weight: 0.3 },
          { name: "description", weight: 0.1 },
        ],
        threshold: 0.35,
        minMatchCharLength: 2,
        ignoreLocation: true,
      }),
    [items],
  );

  // Body scroll lock + ESC handler with deferred close so the exit
  // animation has time to play.
  const close = useMemo(
    () => () => {
      setIsClosing(true);
      window.setTimeout(onClose, 120);
    },
    [onClose],
  );

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const benchItemBySlug = useMemo(() => {
    const map = new Map<string, SearchItem>();
    for (const it of items) {
      if (it.kind === "Benchmark") {
        const slug = it.id.replace(/^bench:/, "");
        map.set(slug, it);
      }
    }
    return map;
  }, [items]);

  // Featured + trending lists arrive pre-resolved from SearchProvider
  // (warmed by a cron + Upstash KV blob, served via /api/search/featured).
  // We zip each card against the search index entry to inherit the URL
  // and any extra item-level metadata. Missing search-index hits drop
  // out silently so a stale slug never breaks the dialog.
  const zip = (cards: FeaturedCardData[] | undefined) =>
    (cards ?? [])
      .map((card) => {
        const item = benchItemBySlug.get(card.slug);
        if (!item) return null;
        return { item, live: card };
      })
      .filter((x): x is { item: SearchItem; live: FeaturedCardData } => Boolean(x));

  const featured = useMemo(
    () => zip(featuredBlob?.featured),
    // benchItemBySlug is stable for a given items array; zipping inside
    // the memo keeps the array reference stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [benchItemBySlug, featuredBlob?.featured],
  );

  const trending = useMemo(
    () => zip(featuredBlob?.trending),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [benchItemBySlug, featuredBlob?.trending],
  );

  // Flat slug → card lookup for the search-results render. Any bench
  // appearing in featured OR trending gets its leader logo on the row;
  // others fall back to the trophy / kind icon. Avoids an extra fetch
  // and keeps the dialog snappy.
  const featuredBySlug = useMemo(() => {
    const map = new Map<string, FeaturedCardData>();
    for (const c of featuredBlob?.featured ?? []) map.set(c.slug, c);
    for (const c of featuredBlob?.trending ?? []) map.set(c.slug, c);
    return map;
  }, [featuredBlob]);

  const results = useMemo<SearchItem[]>(() => {
    const q = query.trim();
    if (!q) return [];
    return fuse.search(q, { limit: 16 }).map((r) => r.item);
  }, [query, fuse]);

  const grouped = useMemo(() => {
    const map = new Map<SearchKind, SearchItem[]>();
    for (const it of results) {
      const list = map.get(it.kind) ?? [];
      list.push(it);
      map.set(it.kind, list);
    }
    return KIND_ORDER
      .map((kind) => ({ kind, list: map.get(kind) ?? [] }))
      .filter((g) => g.list.length > 0);
  }, [results]);

  function go(url: string, entry?: RecentEntry) {
    if (entry) pushRecent(entry);
    close();
    router.push(url);
  }

  function entryFromItem(it: SearchItem): RecentEntry {
    const slug =
      it.kind === "Benchmark"
        ? it.id.replace(/^bench:/, "")
        : it.kind === "Product"
          ? it.id.replace(/^product:/, "")
          : it.kind === "Chain"
            ? it.id.replace(/^chain:/, "")
            : undefined;
    return { id: it.id, title: it.title, url: it.url, kind: it.kind, slug };
  }

  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;
  const showEmpty = isSearching && results.length === 0;

  return (
    <div
      className={[
        "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/60 backdrop-blur-md p-0 sm:p-4 md:p-8",
        isClosing ? "ocb-search-overlay-out" : "ocb-search-overlay-in",
      ].join(" ")}
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Search OpenChainBench"
    >
      <div
        className={[
          "relative w-full max-w-2xl mx-auto sm:mt-[8vh] min-h-screen sm:min-h-0",
          "border border-rule-strong/50 sm:rounded-xl bg-surface sm:shadow-[0_24px_60px_-12px_rgba(0,0,0,0.5)]",
          "font-sans overflow-hidden flex flex-col",
          isClosing ? "ocb-search-card-out" : "ocb-search-card-in",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          label="Site search"
          shouldFilter={false}
          className="flex flex-col flex-1 min-h-0"
        >
          {/* Input row */}
          <div className="flex items-center gap-3 px-4 sm:px-5 h-14 border-b border-rule shrink-0">
            <Search size={18} className="text-ink-faint shrink-0" aria-hidden />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search benchmarks, products, chains, answers…"
              className="flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-faint outline-none border-0 focus:outline-none focus:ring-0"
            />
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="sm:hidden inline-flex items-center justify-center min-h-[36px] min-w-[36px] text-ink-muted hover:text-ink"
            >
              <X size={18} />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="hidden sm:inline-flex"
            >
              <Kbd>esc</Kbd>
            </button>
          </div>

          <Command.List className="flex-1 min-h-0 overflow-y-auto pb-2">
            {/* IDLE STATE — Recent + Featured + Trending */}
            {!isSearching && (
              <div>
                {recent.length > 0 && (
                  <section aria-label="Recent searches">
                    <SectionHeader
                      label="Recent"
                      action={
                        <button
                          type="button"
                          onClick={clearRecent}
                          className="text-[11px] text-ink-faint hover:text-ink-muted transition-colors"
                        >
                          Clear
                        </button>
                      }
                    />
                    <div className="px-3 pb-1">
                      <div className="flex gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden snap-x">
                        {recent.map((r) => {
                          const Icon = KIND_ICON[r.kind];
                          return (
                            <div
                              key={r.id}
                              className="snap-start shrink-0 inline-flex items-stretch rounded-full border border-rule bg-paper-soft hover:border-rule-strong hover:bg-paper transition-colors"
                            >
                              <button
                                type="button"
                                onClick={() => go(r.url, r)}
                                className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-sm text-ink-soft hover:text-ink"
                              >
                                {r.slug && (r.kind === "Product" || r.kind === "Chain") ? (
                                  <ProviderLogo slug={r.slug} name={r.title} size={16} />
                                ) : (
                                  <Icon size={13} className="text-ink-faint" />
                                )}
                                <span className="truncate max-w-[140px]">{r.title}</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeRecent(r.id);
                                }}
                                aria-label={`Remove ${r.title} from recent`}
                                className="inline-flex items-center justify-center w-6 mr-1 text-ink-faint hover:text-ink"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                )}

                {featured.length > 0 && (
                  <section aria-label="Live leaders">
                    <SectionHeader
                      label="Live leaders"
                      action={
                        featuredBlob && (
                          <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-faint">
                            <span className="size-1.5 rounded-full bg-good animate-pulse" />
                            live
                          </span>
                        )
                      }
                    />
                    <div className="px-3 pb-2">
                      <div className="flex gap-2.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden snap-x snap-mandatory -mx-1 px-1">
                        {featured.map(({ item, live }) => {
                          const category = item.tags?.[0] ?? "Benchmark";
                          const isLoading = featuredBlob === null;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => go(item.url, entryFromItem(item))}
                              className="snap-start shrink-0 w-[220px] sm:w-[240px] text-left rounded-lg border border-rule bg-paper-soft hover:border-rule-strong hover:bg-paper transition-colors p-3"
                            >
                              <div className="flex items-center gap-2">
                                <Trophy size={12} className="text-ink-faint" />
                                <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                                  {category}
                                </span>
                              </div>
                              <div className="mt-1.5 text-[13px] font-medium text-ink leading-snug line-clamp-2">
                                {item.title}
                              </div>
                              <div className="mt-2.5 flex items-center justify-between gap-2 h-4">
                                {live?.leader ? (
                                  <>
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <ProviderLogo
                                        slug={live.leader.slug}
                                        name={live.leader.name}
                                        size={16}
                                      />
                                      <span className="text-xs text-ink-muted truncate">
                                        {live.leader.name}
                                      </span>
                                    </div>
                                    <span className="text-xs font-mono text-accent tabular-nums shrink-0">
                                      {fmtUnit(live.value, live.unit)}
                                    </span>
                                  </>
                                ) : isLoading ? (
                                  <>
                                    <span className="h-3.5 w-20 rounded bg-rule animate-pulse" />
                                    <span className="h-3.5 w-12 rounded bg-rule animate-pulse" />
                                  </>
                                ) : (
                                  <span className="text-xs text-ink-faint truncate">
                                    View leaderboard →
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                )}

                {trending.length > 0 && (
                  <section aria-label="Trending benchmarks">
                    <SectionHeader label="Trending" />
                    <Command.Group className="px-2">
                      {trending.map(({ item, live }) => {
                        const category = item.tags?.[0] ?? "Benchmark";
                        const isLoading = featuredBlob === null;
                        return (
                          <Command.Item
                            key={item.id}
                            value={`trending|${item.title}|${item.id}`}
                            onSelect={() => go(item.url, entryFromItem(item))}
                            className="group flex items-center gap-3 rounded-md px-2.5 py-2 cursor-pointer text-sm aria-selected:bg-paper-soft transition-colors"
                          >
                            {live?.leader ? (
                              <ProviderLogo
                                slug={live.leader.slug}
                                name={live.leader.name}
                                size={22}
                              />
                            ) : (
                              <div className="size-[22px] rounded-full bg-paper-soft inline-flex items-center justify-center">
                                <Trophy size={12} className="text-ink-faint" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-medium text-ink truncate">{item.title}</span>
                              </div>
                              <div className="text-xs text-ink-faint truncate">
                                {live?.leader ? (
                                  <>
                                    #1 {live.leader.name} ·{" "}
                                    <span className="font-mono tabular-nums text-ink-muted">
                                      {fmtUnit(live.value, live.unit)}
                                    </span>
                                  </>
                                ) : isLoading ? (
                                  <span className="inline-block h-3 w-32 rounded bg-rule animate-pulse" />
                                ) : (
                                  category
                                )}
                              </div>
                            </div>
                            <ArrowRight
                              size={14}
                              className="text-ink-faint shrink-0 opacity-0 group-aria-selected:opacity-100 transition-opacity"
                            />
                          </Command.Item>
                        );
                      })}
                    </Command.Group>
                  </section>
                )}
              </div>
            )}

            {/* SEARCH RESULTS STATE */}
            {isSearching && (
              <>
                {showEmpty && (
                  <Command.Empty className="px-4 py-12 text-center">
                    <Search size={28} className="mx-auto text-ink-faint mb-3" />
                    <p className="text-sm text-ink-muted">
                      No results for &ldquo;{trimmed}&rdquo;.
                    </p>
                    <p className="mt-1 text-xs text-ink-faint">
                      Try a bench name, provider, or chain.
                    </p>
                  </Command.Empty>
                )}

                {grouped.map(({ kind, list }) => (
                  <Command.Group
                    key={kind}
                    heading={KIND_LABEL[kind]}
                    className="px-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-ink-faint"
                  >
                    {list.map((it) => {
                      const entry = entryFromItem(it);
                      // For benchmark results, try to surface the current
                      // leader's logo if the bench is in our warmed featured/
                      // trending set. Otherwise fall through to the kind-icon
                      // fallback — we deliberately don't fetch /api/citable
                      // here to keep the dialog responsive.
                      const benchLive =
                        it.kind === "Benchmark" && entry.slug
                          ? featuredBySlug.get(entry.slug)
                          : null;
                      const logoSlug =
                        it.kind === "Benchmark"
                          ? benchLive?.leader?.slug
                          : entry.slug;
                      const logoName =
                        it.kind === "Benchmark"
                          ? benchLive?.leader?.name ?? it.title
                          : it.title;
                      return (
                        <Command.Item
                          key={it.id}
                          value={`${it.kind}|${it.title}|${it.id}`}
                          onSelect={() => go(it.url, entry)}
                          className="group flex items-center gap-3 rounded-md px-2.5 py-2 cursor-pointer text-sm aria-selected:bg-paper-soft transition-colors"
                        >
                          {logoSlug ? (
                            <ProviderLogo slug={logoSlug} name={logoName} size={22} />
                          ) : (
                            <div className="size-[22px] rounded-full bg-paper-soft inline-flex items-center justify-center">
                              <KindIcon kind={it.kind} size={12} />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-medium text-ink truncate">
                                {it.title}
                              </span>
                              <span className="text-[9px] uppercase tracking-[0.1em] text-ink-faint shrink-0">
                                {KIND_SINGULAR[it.kind]}
                              </span>
                            </div>
                            {it.description && (
                              <div className="text-xs text-ink-faint truncate">
                                {it.description}
                              </div>
                            )}
                          </div>
                          <ArrowRight
                            size={14}
                            className="text-ink-faint shrink-0 opacity-0 group-aria-selected:opacity-100 transition-opacity"
                          />
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))}
              </>
            )}
          </Command.List>

          {/* Footer */}
          <div className="hidden sm:flex items-center justify-between gap-4 border-t border-rule px-4 py-2.5 text-[11px] text-ink-faint shrink-0">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <span>navigate</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                <span>open</span>
              </span>
            </div>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>esc</Kbd>
              <span>close</span>
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}
