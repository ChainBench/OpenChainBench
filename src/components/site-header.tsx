"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SearchTrigger } from "@/components/search/search-trigger";
import { SiteLogoSwitcher } from "@/components/site-logo-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

function GithubIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

type NavItem = { href: string; label: string; match: (p: string) => boolean };

// Active-state predicates. Bench/product detail pages share the same
// tab as the index, so `/benchmarks/aggregator-head-lag` highlights
// the "Benchmarks" tab. `/` matches exact only — without that, every
// route would inherit a "Home" highlight.
const NAV: NavItem[] = [
  {
    href: "/benchmarks",
    label: "Benchmarks",
    match: (p) => p === "/benchmarks" || p.startsWith("/benchmarks/"),
  },
  {
    href: "/products",
    label: "Products",
    match: (p) => p === "/products" || p.startsWith("/products/"),
  },
  {
    href: "/methodology",
    label: "Methodology",
    match: (p) => p === "/methodology",
  },
  { href: "/about", label: "About", match: (p) => p === "/about" },
  { href: "/contribute", label: "Contribute", match: (p) => p === "/contribute" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "/";

  // Close the mobile menu when the viewport crosses md so the dropdown
  // doesn't stick around as the desktop nav reappears.
  useEffect(() => {
    if (!open) return;
    const mql = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (mql.matches) setOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [open]);

  return (
    <div
      // Sticky everywhere by default. Only iOS in-app WebViews (Telegram,
      // Instagram, FB, etc.) get downgraded to non-sticky to dodge the
      // iOS 26 WebKit jitter bug (bugs.webkit.org/297779). Regular mobile
      // Safari and Chrome iOS keep their sticky nav because the symptom is
      // not visible there in practice. Override lives in globals.css
      // (`html.ios-webview .site-header-root` rule) so the WebView-only
      // selector stays out of the Tailwind class soup here.
      className="site-header-root sticky top-0 z-50 flex flex-col font-sans bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80"
    >
      <header className="border-b border-rule px-4 sm:px-6 shrink-0 text-sm relative">
        <div className="max-w-[1400px] mx-auto flex items-center gap-4 lg:gap-6 h-14 md:h-16">
          <div className="flex items-center gap-2 shrink-0">
            <SiteLogoSwitcher size={22} />
            <Link
              href="/"
              className="group"
              onClick={() => setOpen(false)}
            >
              <span className="font-bold tracking-tight text-[17px] text-ink">
                OpenChainBench
              </span>
            </Link>
          </div>

          {/* Nav links - CMC-style: underline under the active section.
              Items keep a constant pb to avoid layout shift between
              active / inactive states. */}
          <nav className="hidden md:flex items-center h-full gap-5 lg:gap-7 text-[14px] lg:text-[15px] font-medium shrink-0">
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "relative flex items-center h-full transition-colors whitespace-nowrap",
                    active
                      ? "text-ink"
                      : "text-ink-muted hover:text-ink",
                  ].join(" ")}
                >
                  {item.label}
                  {active && (
                    <span
                      aria-hidden
                      className="absolute inset-x-0 -bottom-px h-[2px] bg-accent"
                    />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Search takes the remaining horizontal space (flex-1) so it
              reads as a real input and discoverable without keyboard. */}
          <div className="hidden md:flex flex-1 min-w-0 justify-end lg:justify-center">
            <SearchTrigger variant="desktop" />
          </div>

          {/* Utilities - GitHub + theme, gap-spaced, no pipe. */}
          <div className="hidden md:flex items-center gap-4 text-ink-muted shrink-0">
            <a
              href="https://github.com/ChainBench/OpenChainBench"
              className="inline-flex items-center hover:text-ink transition-colors"
              aria-label="View source on GitHub"
            >
              <GithubIcon size={16} />
            </a>
            <ThemeToggle />
          </div>

          <div className="md:hidden flex items-center -mr-2">
            <SearchTrigger variant="mobile" />
            <button
              type="button"
              className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-ink-muted hover:text-ink transition-colors"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="mobile-nav"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {open && (
          <nav
            id="mobile-nav"
            className="md:hidden absolute left-0 right-0 top-full border-b border-rule bg-surface shadow-lg"
          >
            <ul className="max-w-[1400px] mx-auto px-4 sm:px-6 py-2 flex flex-col">
              {NAV.map((item) => {
                const active = item.match(pathname);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={[
                        "flex items-center min-h-[44px] py-2 transition-colors",
                        active ? "text-ink font-semibold" : "text-ink-muted hover:text-ink",
                      ].join(" ")}
                      onClick={() => setOpen(false)}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
              <li className="border-t border-rule mt-1 pt-1 flex items-center gap-4">
                <a
                  href="https://github.com/ChainBench/OpenChainBench"
                  className="inline-flex items-center gap-2 min-h-[44px] text-ink-muted hover:text-ink transition-colors"
                  aria-label="View source on GitHub"
                  onClick={() => setOpen(false)}
                >
                  <GithubIcon size={15} />
                  GitHub
                </a>
                <span className="ml-auto">
                  <ThemeToggle />
                </span>
              </li>
            </ul>
          </nav>
        )}
      </header>
    </div>
  );
}
