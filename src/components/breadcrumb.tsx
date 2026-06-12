import { Fragment } from "react";
import Link from "next/link";

export type BreadcrumbItem = {
  label: string;
  /** Omitted on the last (current page) item. */
  href?: string;
};

/**
 * Visible breadcrumb trail. Mirrors the BreadcrumbList JSON-LD emitted by
 * the same pages so Google can show the crumb above the URL in the SERP
 * and visitors always know where they are.
 */
export function Breadcrumb({
  items,
  compactLast = false,
}: {
  items: BreadcrumbItem[];
  /** Tighter truncation for deep pages (per-chain benches). */
  compactLast?: boolean;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] sm:tracking-[0.16em] text-ink-faint"
    >
      <ol className="flex flex-wrap items-center gap-1 sm:gap-1.5 min-w-0">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${item.label}-${i}`}>
              {i > 0 && <li aria-hidden>/</li>}
              <li
                className={
                  last && !item.href
                    ? compactLast
                      ? "text-ink-muted truncate max-w-[40vw] sm:max-w-none"
                      : "text-ink-muted truncate max-w-[60vw] sm:max-w-none"
                    : undefined
                }
              >
                {item.href ? (
                  <Link href={item.href} className="hover:text-ink transition-colors">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
