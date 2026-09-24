"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SiteLogoSwitcher } from "@/components/site-logo-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { navGroups } from "@/components/site-nav-items";

/**
 * Left navigation rail, lg and up. The header kept six links while the
 * footer listed twenty, so every vertical the site measures — perps,
 * prediction markets, RWA, bridges, trading apps — was reachable only by
 * scrolling to the bottom of a page. The rail lists all of them.
 *
 * Fixed rather than a grid column: the body grid carries comments about
 * sticky behaviour on iOS and about column sizing that took real effort
 * to get right, and a fixed rail leaves both alone. It works because no
 * ancestor clips overflow — the same reason the header's sticky works.
 * `--sidebar-w` is the single source of the width, so the rail and the
 * content offset cannot drift apart.
 *
 * Below lg it renders nothing and the header's own nav takes over, so
 * phones and tablets are unchanged by this component.
 */
export function SiteSidebar() {
  const pathname = usePathname() ?? "/";
  const groups = navGroups();

  return (
    <aside
      aria-label="Site sections"
      className="hidden lg:flex fixed inset-y-0 left-0 z-40 w-[var(--sidebar-w)] flex-col border-r border-rule bg-surface"
    >
      <div className="flex items-center gap-2 px-4 h-16 shrink-0">
        <SiteLogoSwitcher size={22} />
        <Link href="/" className="font-bold tracking-tight text-[16px] text-ink">
          OpenChainBench
        </Link>
      </div>

      {/* The rail is taller than a short viewport once every group is
          listed, so it scrolls on its own rather than clipping. */}
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} className={gi === 0 ? "" : "mt-4"}>
            {group.label && (
              <p className="label-mono px-3 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                {group.label}
              </p>
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
                        "group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13.5px] transition-colors",
                        active
                          ? "bg-accent/10 text-ink font-medium"
                          : "text-ink-muted hover:bg-paper-soft/60 hover:text-ink",
                      ].join(" ")}
                    >
                      <Icon
                        size={16}
                        className={active ? "text-accent shrink-0" : "text-ink-faint shrink-0 group-hover:text-ink-muted"}
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

      <div className="shrink-0 border-t border-rule px-4 py-3 flex items-center justify-between text-ink-muted">
        <a
          href="https://github.com/ChainBench/OpenChainBench"
          className="text-[12px] hover:text-ink transition-colors"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        <ThemeToggle />
      </div>
    </aside>
  );
}
