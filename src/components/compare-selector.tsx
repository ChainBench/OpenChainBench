"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import {
  canonicalPairSlug,
  type CompareCandidate,
} from "@/lib/compare-pairing-shared";

/**
 * Two combobox selector that lets a visitor build any compatible head
 * to head from the /compare hub without scanning the full pair list.
 *
 * Behaviour:
 *   - First picker shows every provider that has at least one bench.
 *   - Once a provider is picked, the second picker filters down to the
 *     providers that share at least one bench with the first (using the
 *     precomputed `shared` map from buildCompareGraph).
 *   - Compare CTA navigates to the canonical pair slug (alphabetical),
 *     so /compare/a-vs-b is the same target as /compare/b-vs-a.
 */
export function CompareSelector({
  providers,
  shared,
}: {
  providers: CompareCandidate[];
  shared: Record<string, string[]>;
}) {
  const [aSlug, setASlug] = useState<string>("");
  const [bSlug, setBSlug] = useState<string>("");
  const router = useRouter();

  const candidatesForB = useMemo(() => {
    if (!aSlug) return providers;
    const eligible = new Set(shared[aSlug] ?? []);
    return providers.filter((p) => eligible.has(p.slug));
  }, [aSlug, providers, shared]);

  const handleCompare = () => {
    if (!aSlug || !bSlug) return;
    router.push(`/compare/${canonicalPairSlug(aSlug, bSlug)}`);
  };

  return (
    <section className="card-soft rounded-2xl p-5 sm:p-6 mb-10">
      <h2 className="display text-base sm:text-lg tracking-tight text-ink">
        Compare any two providers
      </h2>
      <p className="mt-1 text-xs sm:text-sm text-ink-soft leading-snug">
        Pick a first provider, the second picker auto filters to
        providers that share at least one bench with it.
      </p>
      <div className="mt-5 flex flex-col sm:grid sm:grid-cols-[1fr_auto_1fr_auto] gap-3 items-stretch sm:items-center">
        <Picker
          providers={providers}
          value={aSlug}
          onChange={(s) => {
            setASlug(s);
            setBSlug("");
          }}
          placeholder="Pick a provider"
        />
        <span className="text-ink-faint text-[10px] uppercase tracking-[0.16em] text-center self-center hidden sm:block">
          vs
        </span>
        <Picker
          providers={candidatesForB.filter((p) => p.slug !== aSlug)}
          value={bSlug}
          onChange={setBSlug}
          placeholder={aSlug ? "Pick a second" : "Pick first one first"}
          disabled={!aSlug}
        />
        <button
          type="button"
          onClick={handleCompare}
          disabled={!aSlug || !bSlug}
          className="rounded-md bg-accent hover:bg-accent/90 text-white px-4 py-2.5 text-sm font-semibold tracking-wide uppercase transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Compare
        </button>
      </div>
    </section>
  );
}

function Picker({
  providers,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  providers: CompareCandidate[];
  value: string;
  onChange: (slug: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = providers.find((p) => p.slug === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
    );
  }, [providers, query]);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 rounded-md border border-rule px-3 py-2.5 text-sm hover:border-ink/40 disabled:opacity-40 disabled:cursor-not-allowed bg-surface text-ink"
      >
        {selected ? (
          <>
            <ProviderLogo
              slug={selected.slug}
              name={selected.name}
              size={20}
            />
            <span className="truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-ink-faint">{placeholder}</span>
        )}
        <ChevronDown
          size={14}
          strokeWidth={2}
          className="ml-auto text-ink-faint shrink-0"
        />
      </button>
      {open && !disabled && (
        <>
          <button
            type="button"
            aria-label="Close picker"
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute z-40 mt-1 w-full bg-surface border border-rule rounded-md shadow-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-rule">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type to filter"
                autoFocus
                className="w-full text-sm bg-transparent text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </div>
            <ul className="max-h-72 overflow-y-auto">
              {filtered.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p.slug);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-paper text-ink"
                  >
                    <ProviderLogo
                      slug={p.slug}
                      name={p.name}
                      size={20}
                    />
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-3 py-3 text-xs text-ink-faint">
                  No match{query ? ` for "${query}"` : ""}
                </li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
