"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SearchTrigger } from "@/components/search/search-trigger";
import { SiteLogoSwitcher } from "@/components/site-logo-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { navGroups } from "@/components/site-nav-items";

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1200 1227" fill="currentColor" aria-hidden>
      <path d="M714.163 519.284 1160.89 0h-105.86L667.137 450.887 357.328 0H0l468.492 681.821L0 1226.37h105.866l409.625-476.152 327.181 476.152H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894-377.686-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z" />
    </svg>
  );
}

function GithubIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * Left navigation rail, lg and up. The header offered six links while the
 * footer listed twenty, so every vertical the site measures — perps,
 * prediction markets, RWA, bridges, trading apps — was reachable only by
 * scrolling to the bottom of a page. The rail lists all of them.
 *
 * It carries the whole chrome, not just the links: wordmark, search,
 * sections, socials and the theme toggle. The first cut left those in the
 * header, which then had nothing on its left half and a search pill
 * floating in the middle of 64 px of empty bar. Moving them here lets the
 * header disappear entirely at lg, and the rail is fixed, so search stays
 * put while the page scrolls instead of riding a sticky bar.
 *
 * Type matches the header nav it replaces (13 px, medium) rather than
 * inventing a second scale for the same job.
 *
 * Fixed rather than a grid column: the shell's body grid carries comments
 * about iOS sticky behaviour and column sizing that were both hard-won,
 * and a fixed rail leaves them alone. It works for the same reason the
 * sticky header does — no ancestor clips overflow. `--sidebar-w` is the
 * single source of the width, so rail and content offset cannot drift.
 *
 * Below lg it renders nothing and the header takes over, so phones and
 * tablets are untouched by this component.
 */
export function SiteSidebar() {
  const pathname = usePathname() ?? "/";
  const groups = navGroups();

  return (
    <aside
      aria-label="Site sections"
      className="hidden lg:flex fixed inset-y-0 left-0 z-40 w-[var(--sidebar-w)] flex-col font-sans border-r border-rule bg-surface"
    >
      <div className="flex items-center gap-2 px-4 h-16 shrink-0">
        <SiteLogoSwitcher size={22} />
        <Link href="/" className="font-bold tracking-tight text-[16px] text-ink">
          OpenChainBench
        </Link>
      </div>

      <div className="px-3 pb-3 shrink-0">
        <SearchTrigger variant="desktop" />
      </div>

      {/* Taller than a short viewport once every group is listed, so the
          list scrolls on its own rather than clipping. */}
      <nav className="flex-1 overflow-y-auto px-2 pb-4 text-[13px] font-medium">
        {groups.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} className={gi === 0 ? "" : "mt-4"}>
            {group.label && (
              <p className="label-mono px-3 pb-1 text-ink-faint">{group.label}</p>
            )}
            <ul>
              {group.items.map((item) => {
                const active = item.match(pathname);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={[
                        "group flex items-center gap-2.5 rounded-md px-3 py-[7px] transition-colors",
                        active
                          ? "bg-accent/10 text-ink"
                          : "text-ink-muted hover:bg-paper-soft hover:text-ink",
                      ].join(" ")}
                    >
                      <Icon
                        size={15}
                        className={
                          active
                            ? "text-accent shrink-0"
                            : "text-ink-faint shrink-0 group-hover:text-ink-muted"
                        }
                        aria-hidden
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-rule px-4 py-3 flex items-center gap-4 text-ink-muted">
        <a
          href="https://x.com/OpenChainBench"
          className="inline-flex items-center hover:text-ink transition-colors"
          aria-label="Follow @OpenChainBench on X"
          target="_blank"
          rel="noopener noreferrer"
        >
          <XIcon size={13} />
        </a>
        <a
          href="https://github.com/ChainBench/OpenChainBench"
          className="inline-flex items-center hover:text-ink transition-colors"
          aria-label="View source on GitHub"
          target="_blank"
          rel="noopener noreferrer"
        >
          <GithubIcon size={15} />
        </a>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
