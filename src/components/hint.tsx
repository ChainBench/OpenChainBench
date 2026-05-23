"use client";

import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

/**
 * Hover / focus tooltip primitive. Replaces the 24+ `title={...}`
 * native attributes scattered across the chart components - native
 * `title` triggers the browser tooltip (800 ms delay, ugly default
 * UA styling, untouchable by CSS, hidden on touch devices entirely)
 * which was the single biggest "amateur look" tell on the site.
 *
 * Renders a portal-less floating panel anchored to the trigger.
 * Show is delayed 120 ms (matches Stripe / Linear feel) so a fast
 * pointer-over doesn't fire dozens of pop-ups. Keyboard focus reveals
 * it immediately (no delay) because keyboard users have intentional
 * targeting.
 *
 * Falls back to a native `title` attribute when JS hasn't booted yet
 * so SSR / no-JS clients still get a tooltip - just the ugly browser
 * one - rather than nothing.
 */
export function Hint({
  label,
  children,
  side = "top",
  className = "",
}: {
  /** Tooltip body. Plain string or short JSX. Long copy belongs in a
   *  dedicated <details> / accordion, not a hover panel. */
  label: ReactNode;
  /** The trigger - typically the icon / row / slice the user hovers. */
  children: ReactNode;
  /** Which side of the trigger the bubble appears on. */
  side?: "top" | "bottom" | "left" | "right";
  /** Extra classes for the trigger wrapper. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const id = useId();

  const cancelTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Cleanup on unmount so we don't leak a setTimeout that fires after
  // the component has been removed (e.g. switching benches mid-hover).
  useEffect(() => () => cancelTimer(), []);

  const onEnter = () => {
    cancelTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), 120);
  };
  const onLeave = () => {
    cancelTimer();
    setOpen(false);
  };
  // Focus reveals immediately - keyboard users target intentionally,
  // no need to debounce.
  const onFocus = () => {
    cancelTimer();
    setOpen(true);
  };
  const onBlur = () => {
    cancelTimer();
    setOpen(false);
  };

  // Pre-stringify so the fallback `title` attribute still works even
  // when `label` is a ReactNode that contains plain text.
  const labelString =
    typeof label === "string"
      ? label
      : typeof label === "number"
        ? String(label)
        : undefined;

  const sideClasses: Record<typeof side, string> = {
    top: "bottom-full mb-1.5 left-1/2 -translate-x-1/2",
    bottom: "top-full mt-1.5 left-1/2 -translate-x-1/2",
    left: "right-full mr-1.5 top-1/2 -translate-y-1/2",
    right: "left-full ml-1.5 top-1/2 -translate-y-1/2",
  };

  return (
    <span
      ref={wrapRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      aria-describedby={open ? id : undefined}
    >
      {/* Pass title= for the SSR / no-JS fallback. Browsers ignore it
          when our floating panel is showing. */}
      <span title={labelString} className="contents">
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute z-30 pointer-events-none whitespace-pre-line max-w-[280px] text-[11.5px] leading-snug font-sans px-2.5 py-1.5 rounded-md bg-ink text-paper shadow-lg ${sideClasses[side]}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
