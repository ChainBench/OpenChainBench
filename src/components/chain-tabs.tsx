"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useTransition } from "react";

type ChainOption = { value: string; label: string };

/**
 * Chain filter tabs rendered above the chart on a bench detail page.
 * Updates `?chain=X` in the URL (or removes it for "All"). The server
 * component re-fetches Prometheus with the chain filter injected.
 *
 * On mount we eagerly prefetch every variant (All + each chain) so a
 * click swaps data instantly, without waiting for the round-trip.
 */
export function ChainTabs({
  options,
  selected,
}: {
  options: ChainOption[];
  selected: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Prefetch all chain variants once on mount. Subsequent clicks are
  // served from the Next.js client cache instead of doing a fresh
  // Prometheus round-trip.
  useEffect(() => {
    const targets: string[] = [];
    {
      const p = new URLSearchParams(searchParams.toString());
      p.delete("chain");
      const qs = p.toString();
      targets.push(qs ? `${pathname}?${qs}` : pathname);
    }
    for (const o of options) {
      const p = new URLSearchParams(searchParams.toString());
      p.set("chain", o.value);
      targets.push(`${pathname}?${p.toString()}`);
    }
    for (const t of targets) router.prefetch(t);
  }, [router, pathname, searchParams, options]);

  function pick(value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete("chain");
    else params.set("chain", value);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1 border border-rule rounded p-1 bg-paper-soft w-fit"
      data-pending={pending ? "" : undefined}
    >
      <Tab onClick={() => pick(null)} active={selected === null} label="All chains" />
      {options.map((o) => (
        <Tab
          key={o.value}
          onClick={() => pick(o.value)}
          active={selected === o.value}
          label={o.label}
        />
      ))}
    </div>
  );
}

function Tab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded transition-colors ${
        active
          ? "bg-paper text-ink shadow-sm"
          : "text-ink-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
