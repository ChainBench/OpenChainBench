"use client";

import Link from "next/link";
import { CATEGORIES } from "@/lib/categories";

type SubItem = { href: string; label: string; match: (p: string) => boolean };

// Per-section contextual sub-nav. Modelled on the CMC chart-hub pattern
// (horizontally scrollable category tabs below the main nav). The
// bench section is the only one with a deep enough taxonomy to need
// this today; other sections render nothing rather than an empty
// 40px-tall strip that would just push content down.
function getItems(pathname: string): SubItem[] | null {
  if (pathname === "/benchmarks" || pathname.startsWith("/benchmarks/")) {
    const items: SubItem[] = [
      {
        href: "/benchmarks",
        label: "All",
        match: (p) =>
          p === "/benchmarks" ||
          (p.startsWith("/benchmarks/") && !p.startsWith("/benchmarks/category/")),
      },
    ];
    for (const c of CATEGORIES) {
      const href = `/benchmarks/category/${c.slug}`;
      items.push({
        href,
        label: c.label,
        match: (p) => p === href,
      });
    }
    return items;
  }
  return null;
}

export function SiteSubNav({ pathname }: { pathname: string }) {
  const items = getItems(pathname);
  if (!items) return null;

  return (
    <div className="border-b border-rule bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <nav
        aria-label="Section navigation"
        className="max-w-[1400px] mx-auto px-4 sm:px-6"
      >
        {/* Horizontal scroll on mobile, no scrollbar. Edge-fade hint via
            mask-image so the cut-off tabs read as scrollable rather than
            clipped. */}
        <ul
          className="flex items-stretch gap-1 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_0,black_calc(100%-24px),transparent_100%)] md:[mask-image:none]"
        >
          {items.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "relative inline-flex items-center h-10 px-3 text-[13px] font-medium transition-colors",
                    active
                      ? "text-ink"
                      : "text-ink-muted hover:text-ink",
                  ].join(" ")}
                >
                  {item.label}
                  {active && (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 -bottom-px h-[2px] bg-accent rounded-full"
                    />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
