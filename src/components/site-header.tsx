"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SiteBanner } from "@/components/site-banner";
import { SiteLogoSwitcher } from "@/components/site-logo-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

function GithubIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

const NAV = [
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/products", label: "Products" },
  { href: "/methodology", label: "Methodology" },
  { href: "/about", label: "About" },
  { href: "/contribute", label: "Contribute" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);

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
    <div className="sticky top-0 z-50 flex flex-col font-sans pt-[env(safe-area-inset-top)]">
      <SiteBanner />
      <header className="border-b border-rule py-4 md:py-5 px-4 sm:px-6 shrink-0 text-sm bg-surface relative">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
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

          <nav className="hidden md:flex items-center gap-8 text-ink-muted font-medium">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="hover:text-ink transition-colors"
              >
                {item.label}
              </Link>
            ))}
            <span className="text-rule-strong">|</span>
            <a
              href="https://github.com/ChainBench/OpenChainBench"
              className="inline-flex items-center gap-1.5 hover:text-ink transition-colors"
              aria-label="View source on GitHub"
            >
              <GithubIcon size={15} />
              GitHub
            </a>
            <ThemeToggle />
          </nav>

          <button
            type="button"
            className="md:hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 rounded text-ink-muted hover:text-ink transition-colors"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        {open && (
          <nav
            id="mobile-nav"
            className="md:hidden absolute left-0 right-0 top-full border-b border-rule bg-surface shadow-lg"
          >
            <ul className="max-w-[1400px] mx-auto px-4 sm:px-6 py-2 flex flex-col">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex items-center min-h-[44px] py-2 text-ink-muted hover:text-ink transition-colors"
                    onClick={() => setOpen(false)}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
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
