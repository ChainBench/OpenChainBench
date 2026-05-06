"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

type ChainOption = { value: string; label: string };

/**
 * Chain filter tabs rendered above the chart on a bench detail page.
 * Updates `?chain=X` in the URL (or removes it for "All"). The server
 * component re-fetches Prometheus with the chain filter injected.
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
