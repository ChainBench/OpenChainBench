"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

const PIN_KEY = "ocb:sidebar-pinned";

/**
 * The pin, read through an external store rather than restored with a
 * setState inside an effect: that version painted unpinned and then
 * pinned on a second pass, which lint flags as a cascading render and a
 * reader sees as a flicker. The server snapshot is false, so markup
 * matches on hydration and the real value lands in the same commit.
 *
 * Storage can throw (private mode, blocked site data) and can be absent
 * (SSR); both read as "not pinned", which is the behaviour this feature
 * defaults to anyway.
 */
const pinListeners = new Set<() => void>();
function readPin(): boolean {
  try {
    return window.localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}
function subscribePin(cb: () => void) {
  pinListeners.add(cb);
  // Another tab toggling the pin should move this one too.
  window.addEventListener("storage", cb);
  return () => {
    pinListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function writePin(v: boolean) {
  try {
    window.localStorage.setItem(PIN_KEY, v ? "1" : "0");
  } catch {
    // Not persisting is survivable; the session still honours it.
  }
  for (const cb of pinListeners) cb();
}
/** How long the pointer has to be away before the rail narrows. Long
 *  enough to cross the rail on the way somewhere else without it
 *  collapsing under the cursor, short enough that it is out of the way
 *  by the time the eye lands on the page (1.6 s read as lingering). */
const COLLAPSE_DELAY_MS = 450;
/** The rail starts wide so a first-time visitor sees the sections, then
 *  narrows once — which is also how they learn it does that. */
const FIRST_COLLAPSE_MS = 2600;

/**
 * Left navigation rail, lg and up. The header offered six links while the
 * footer listed twenty, so every vertical the site measures — perps,
 * prediction markets, RWA, bridges, trading apps — was reachable only by
 * scrolling to the bottom of a page. The rail lists all of them, and
 * carries the rest of the chrome too: wordmark, search, socials, theme.
 *
 * It narrows to an icon strip when the pointer is elsewhere and widens
 * when the pointer comes near the left edge. Three decisions make that
 * behave rather than annoy:
 *
 *  - The collapsed width is the real layout offset and the expanded rail
 *    OVERLAYS the page. Animating the page's own offset would reflow
 *    every column each time the cursor drifted left, which is unusable.
 *  - Collapsed still shows the icons, not just the wordmark. A strip
 *    with nothing in it gives no clue that navigation lives there; the
 *    icons are the hint, and they stay clickable the whole time.
 *  - It can be pinned. Auto-collapse is a preference, not a law, so the
 *    toggle at the foot holds it open and the choice survives reloads.
 *
 * Keyboard focus counts as presence, so tabbing through the sections
 * keeps it open; `prefers-reduced-motion` drops the width transition.
 *
 * Fixed rather than a grid column: the shell's body grid carries comments
 * about iOS sticky behaviour and column sizing that were both hard-won,
 * and a fixed rail leaves them alone.
 */
export function SiteSidebar() {
  const pathname = usePathname() ?? "/";
  const groups = navGroups();

  const pinned = useSyncExternalStore(subscribePin, readPin, () => false);
  const [near, setNear] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = pinned || near;

  // The page makes room whenever the rail is open. The first version
  // tied this to the pin alone and let the open rail overlay the page,
  // which cut the H1 in half and hid the first card: content you cannot
  // read is worse than content that moves.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-sidebar", open ? "open" : "rail");
    return () => root.removeAttribute("data-sidebar");
  }, [open]);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hold = useCallback(() => {
    clear();
    setNear(true);
  }, []);
  const release = useCallback((delay = COLLAPSE_DELAY_MS) => {
    clear();
    timer.current = setTimeout(() => setNear(false), delay);
  }, []);

  // One wide beat on first paint, then settle.
  useEffect(() => {
    release(FIRST_COLLAPSE_MS);
    return clear;
  }, [release]);


  const togglePin = () => {
    const next = !pinned;
    writePin(next);
    if (!next) release();
  };

  return (
    <>
      {/* A strip of pointer target just off the rail's edge, so the rail
          opens as the cursor arrives rather than only once it lands. */}
      <div
        aria-hidden
        className="hidden lg:block fixed inset-y-0 left-0 z-30 pointer-events-none"
        style={{ width: open ? 0 : "calc(var(--sidebar-rail-w) + 14px)" }}
        onMouseEnter={hold}
      >
        <div className="h-full w-full pointer-events-auto" onMouseEnter={hold} />
      </div>

      <aside
        aria-label="Site sections"
        data-open={open ? "true" : "false"}
        onMouseEnter={hold}
        onMouseLeave={() => release()}
        onFocusCapture={hold}
        onBlurCapture={(e) => {
          // Only let go once focus has actually left the rail.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release();
        }}
        className="site-rail hidden lg:flex fixed inset-y-0 left-0 z-40 flex-col font-sans"
      >
        {/* Keeps its full width and its words while the rest of the rail
            narrows: collapsed, this is the page's brand mark sitting on
            the page rather than a label inside a panel. Hence the fixed
            width (so the text never reflows mid-transition), the visible
            overflow (so the 62px strip does not clip it) and the
            pointer-events dance (so the empty width beside the words
            does not swallow clicks meant for the page). */}
        <div className="site-rail-brand flex items-center gap-2 h-16 shrink-0 px-[18px]">
          <Link
            href="/"
            className="flex items-center gap-2 pointer-events-auto"
            aria-label="OpenChainBench home"
          >
            <span className="shrink-0">
              <SiteLogoSwitcher size={22} />
            </span>
            <span className="font-bold tracking-tight text-[16px] text-ink whitespace-nowrap">
              OpenChainBench
            </span>
          </Link>
        </div>

        {/* Collapsed, this reads as a search icon in the strip; expanded,
            it is the same trigger the header uses below lg. */}
        <div className="px-3 pb-3 shrink-0 overflow-hidden">
          <div className="site-rail-search">
            <SearchTrigger variant="desktop" />
          </div>
          <Link
            href="/"
            aria-hidden
            tabIndex={-1}
            className="site-rail-icon-only hidden items-center justify-center h-9 rounded-md border border-rule bg-paper-soft text-ink-faint"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4 text-[13px] font-medium">
          {groups.map((group, gi) => (
            <div key={group.label ?? `g${gi}`} className={gi === 0 ? "" : "site-rail-gap"}>
              {group.label && (
                <p className="site-rail-group label-mono px-3 pb-1 text-ink-faint whitespace-nowrap">
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
                        // The label is clipped when narrow, so the title
                        // is what a collapsed icon answers to.
                        title={item.label}
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
                        <span className="site-rail-label truncate whitespace-nowrap">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-rule px-4 py-3 flex items-center gap-4 text-ink-muted overflow-hidden">
          <button
            type="button"
            onClick={togglePin}
            aria-pressed={pinned}
            title={pinned ? "Unpin the sidebar" : "Keep the sidebar open"}
            className="inline-flex items-center hover:text-ink transition-colors shrink-0"
          >
            {pinned ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            <span className="sr-only">{pinned ? "Unpin the sidebar" : "Keep the sidebar open"}</span>
          </button>
          <a
            href="https://x.com/OpenChainBench"
            className="site-rail-label inline-flex items-center hover:text-ink transition-colors"
            aria-label="Follow @OpenChainBench on X"
            target="_blank"
            rel="noopener noreferrer"
          >
            <XIcon size={13} />
          </a>
          <a
            href="https://github.com/ChainBench/OpenChainBench"
            className="site-rail-label inline-flex items-center hover:text-ink transition-colors"
            aria-label="View source on GitHub"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GithubIcon size={15} />
          </a>
          <div className="site-rail-label ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
