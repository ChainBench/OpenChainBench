import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared primitive for the "card-soft" link tiles that paint the hub
 * pages (alternatives, compare, chains, answers top-results, etc.).
 *
 * The hub cards all rendered the same skeleton inline - logo on the left,
 * title + subtitle in the middle, a chevron or pill on the right. Pulling
 * the markup here keeps the hover state, padding ramp and shape contract
 * (`card-soft rounded-xl ... hover:border-ink/40 transition-colors`) in
 * one place so a future restyle doesn't require chasing 8 call sites.
 *
 * Three layouts:
 * - `variant="default"` (row, p-4 sm:p-5): roomy hub tile.
 * - `variant="compact"` (row, p-4): tighter hub-index shape used by
 *   /alternatives, /compare, /chains.
 * - `variant="stack"` (column, p-4): the stat-card shape used by the
 *   "Top N" sections in /answers/[slug] and /alternatives/[slug]. Top
 *   row stays the same; the bottom row is whatever `children` provides
 *   (typically a metric value strip).
 *
 * `subtitle` is a passthrough ReactNode. Pass a plain string to get the
 * default paragraph styling, or pass a fully-styled element (e.g. the
 * `label-mono` caption that compare/chains used inline) to opt out.
 */
interface LogoCardLinkProps {
  href: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Logo, chain icon, emoji, dual-logo stack - anything that paints on the left. */
  logo?: ReactNode;
  /** Right-side affordance: chevron, pill, type badge, status dot. */
  rightSlot?: ReactNode;
  /** Extra content rendered below the top row (only painted when variant="stack"). */
  children?: ReactNode;
  className?: string;
  variant?: "default" | "compact" | "stack";
}

export function LogoCardLink({
  href,
  title,
  subtitle,
  logo,
  rightSlot,
  children,
  className,
  variant = "default",
}: LogoCardLinkProps) {
  const padding = variant === "default" ? "p-4 sm:p-5" : "p-4";
  const layout =
    variant === "stack"
      ? "flex flex-col gap-2"
      : "flex items-center gap-4";

  const base = `card-soft rounded-xl ${padding} h-full transition-colors hover:border-ink/40 group ${layout}`;
  const merged = className ? `${base} ${className}` : base;

  // String subtitles get the default paragraph styling so the common
  // /alternatives case stays a one-liner. Non-string subtitles render
  // as-is so /compare and /chains can keep their uppercase mono caption.
  const renderSubtitle = () => {
    if (subtitle == null) return null;
    if (typeof subtitle === "string") {
      return (
        <p className="mt-1 text-sm text-ink-muted line-clamp-2 leading-snug">
          {subtitle}
        </p>
      );
    }
    return subtitle;
  };

  if (variant === "stack") {
    return (
      <Link href={href} className={merged}>
        <div className="flex items-center gap-3">
          {logo && <div className="shrink-0">{logo}</div>}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink leading-tight truncate">
              {title}
            </p>
            {subtitle && (
              <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint font-medium">
                {subtitle}
              </p>
            )}
          </div>
          {rightSlot && <div className="shrink-0">{rightSlot}</div>}
        </div>
        {children}
      </Link>
    );
  }

  return (
    <Link href={href} className={merged}>
      {logo && <div className="shrink-0">{logo}</div>}
      <div className="min-w-0 flex-1">
        <p className="display text-base sm:text-lg tracking-tight text-ink leading-tight truncate">
          {title}
        </p>
        {renderSubtitle()}
      </div>
      {rightSlot && <div className="shrink-0">{rightSlot}</div>}
    </Link>
  );
}
