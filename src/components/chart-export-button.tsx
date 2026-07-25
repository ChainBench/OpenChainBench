"use client";

/**
 * One-click PNG export for any chart wrapped by a ref'd container.
 *
 * UX shape: single split button — click to copy, tiny caret to open the
 * download variant. Keeps the chart header uncluttered while giving
 * both flows one gesture. Icon-only by default (with tooltips) so the
 * button doesn't take label real estate; expands to text on hover for
 * discoverability.
 *
 * Rasterisation goes through `html-to-image` so both SVG (time-series)
 * and HTML-composed (ranked bar) charts capture correctly, including
 * the `<ChartWatermark*>` attribution inside the frame.
 *
 * Clipboard path uses `navigator.clipboard.write(ClipboardItem)` which
 * is Chromium + Safari; Firefox falls through to the download flow with
 * no user-visible failure. Server + non-secure contexts also fall back.
 */

import { useCallback, useState } from "react";
import { Copy, Download, Check, Loader2 } from "lucide-react";
import { toPng } from "html-to-image";

type Props = {
  /** Ref to the element to capture. Should include chart + watermark. */
  targetRef: import("react").RefObject<HTMLElement | null>;
  /** Filename prefix (no extension). Slug or bench name typically. */
  filename?: string;
  /** Optional class to tweak wrapper size. */
  className?: string;
};

const PIXEL_RATIO = 2; // Retina-quality PNG for legible screenshots.

export function ChartExportButton({
  targetRef,
  filename = "openchainbench-chart",
  className = "",
}: Props) {
  const [state, setState] = useState<"idle" | "working" | "copied" | "error">("idle");

  const capture = useCallback(async (): Promise<Blob | null> => {
    const el = targetRef.current;
    if (!el) return null;
    // Force a solid background — html-to-image renders transparency by
    // default which produces unreadable screenshots on dark UIs when the
    // user pastes into a light chat / doc.
    const bg =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-paper")
        .trim() || "#0b0b0d";
    const dataUrl = await toPng(el, {
      pixelRatio: PIXEL_RATIO,
      backgroundColor: bg,
      cacheBust: true,
      // Skip external images with tainted crossOrigin (provider logos are
      // same-origin from /logos/* so they render fine; anything else that
      // fails to load is silently dropped rather than aborting the whole
      // export).
      skipFonts: false,
      style: { boxShadow: "none" },
    });
    const res = await fetch(dataUrl);
    return await res.blob();
  }, [targetRef]);

  const onCopy = useCallback(async () => {
    setState("working");
    try {
      const blob = await capture();
      if (!blob) throw new Error("no target");
      if (
        typeof navigator !== "undefined" &&
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.write === "function"
      ) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setState("copied");
        setTimeout(() => setState("idle"), 1600);
        return;
      }
      // Fallback: trigger download when clipboard write is unavailable
      // (Firefox, insecure contexts, older Safari).
      triggerDownload(blob, filename);
      setState("copied");
      setTimeout(() => setState("idle"), 1600);
    } catch (err) {
      console.warn("[chart-export] copy failed", err);
      setState("error");
      setTimeout(() => setState("idle"), 2200);
    }
  }, [capture, filename]);

  const onDownload = useCallback(async () => {
    setState("working");
    try {
      const blob = await capture();
      if (!blob) throw new Error("no target");
      triggerDownload(blob, filename);
      setState("copied");
      setTimeout(() => setState("idle"), 1200);
    } catch (err) {
      console.warn("[chart-export] download failed", err);
      setState("error");
      setTimeout(() => setState("idle"), 2200);
    }
  }, [capture, filename]);

  return (
    <span className={`inline-flex items-center rounded-md border border-ink/15 bg-paper shadow-sm ${className}`}>
      <button
        type="button"
        onClick={onCopy}
        disabled={state === "working"}
        className="inline-flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] text-ink transition-colors hover:bg-paper-soft disabled:opacity-60"
        title="Copy chart as PNG to clipboard"
        aria-label="Copy chart as PNG"
      >
        {state === "working" ? (
          <Loader2 size={11} strokeWidth={2} className="animate-spin" />
        ) : state === "copied" ? (
          <Check size={11} strokeWidth={2.4} />
        ) : (
          <Copy size={11} strokeWidth={2} />
        )}
        <span className="hidden sm:inline">
          {state === "copied" ? "Copied" : state === "error" ? "Failed" : "Copy"}
        </span>
      </button>
      <span aria-hidden className="h-4 w-px bg-ink/15" />
      <button
        type="button"
        onClick={onDownload}
        disabled={state === "working"}
        className="inline-flex items-center gap-1.5 rounded-r-md px-2 py-1 text-ink transition-colors hover:bg-paper-soft disabled:opacity-60"
        title="Download chart as PNG"
        aria-label="Download chart as PNG"
      >
        <Download size={11} strokeWidth={2} />
      </button>
    </span>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
