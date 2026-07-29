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
import { Copy, Download, Check, Loader2, FileText } from "lucide-react";
import { toBlob } from "html-to-image";
import { Hint } from "@/components/hint";

type CsvLine = { slug: string; name: string; values: (number | null)[] };

type Props = {
  /** Ref to the element to capture. Should include chart + watermark. */
  targetRef: import("react").RefObject<HTMLElement | null>;
  /** Filename prefix (no extension). Slug or bench name typically. */
  filename?: string;
  /** Optional class to tweak wrapper size. */
  className?: string;
  /** When provided, shows a CSV download button. */
  csvLines?: CsvLine[];
  /** Total hours the series spans (used to back-fill timestamps). */
  rangeHours?: number;
  /** Expected number of points in each series. */
  rangePoints?: number;
};

const PIXEL_RATIO = 2; // Retina-quality PNG for legible screenshots.

export function ChartExportButton({
  targetRef,
  filename = "openchainbench-chart",
  className = "",
  csvLines,
  rangeHours = 24,
  rangePoints,
}: Props) {
  const [state, setState] = useState<
    "idle" | "working" | "copied" | "downloaded" | "error"
  >("idle");
  const [csvState, setCsvState] = useState<"idle" | "done">("idle");

  const capture = useCallback(async (): Promise<Blob | null> => {
    const el = targetRef.current;
    if (!el) return null;
    // Force a solid background — html-to-image renders transparency by
    // default which produces unreadable screenshots on dark UIs when the
    // user pastes into a light chat / doc. The computed value from the
    // page CSS is normally an oklch(...) triple which the canvas ctx
    // accepts fine, but if unset we hard-fall-back to a dark hex so
    // the export never leaks a transparent PNG.
    const bg =
      getComputedStyle(document.body).backgroundColor ||
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-paper")
        .trim() ||
      "#0b0b0d";
    // toBlob → direct Blob output. Avoids the dataURL → fetch → blob()
    // intermediate step which OOMs for large canvases in Safari and
    // sometimes silently produces empty PNGs. Also skips the "download
    // blocked because the click gesture context expired" trap since we
    // hand a real Blob to the caller synchronously right after await.
    // Use scrollHeight/scrollWidth so the full content is captured even
    // when a parent scroll container makes only part of the figure visible
    // on screen. Without this, html-to-image uses offsetHeight which clips
    // the legend when it wraps into many rows (100+ provider benches).
    const blob = await toBlob(el, {
      pixelRatio: PIXEL_RATIO,
      backgroundColor: bg,
      cacheBust: true,
      skipFonts: false,
      width: el.scrollWidth || el.offsetWidth,
      height: el.scrollHeight || el.offsetHeight,
      // Drop the export button itself from the capture — no point
      // baking the "Copy" pill into every screenshot. Also drop any
      // element marked with data-chart-export-omit (e.g. the chart's
      // header metadata row and the Top-N selector) so the exported
      // PNG focuses on the plot itself, not the interactive UI chrome.
      filter: (node) => {
        if (!(node instanceof HTMLElement)) return true;
        if (node.dataset.chartExportButton) return false;
        if (node.dataset.chartExportOmit) return false;
        return true;
      },
      style: { boxShadow: "none" },
    });
    return blob;
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
      console.error("[chart-export] copy failed", err);
      setState("error");
      setTimeout(() => setState("idle"), 2200);
    }
  }, [capture, filename]);

  const onDownload = useCallback(async () => {
    setState("working");
    try {
      const blob = await capture();
      if (!blob) throw new Error("capture returned no blob");
      triggerDownload(blob, filename);
      setState("downloaded");
      setTimeout(() => setState("idle"), 1600);
    } catch (err) {
      console.error("[chart-export] download failed", err);
      setState("error");
      setTimeout(() => setState("idle"), 2200);
    }
  }, [capture, filename]);

  const onDownloadCsv = useCallback(() => {
    if (!csvLines || csvLines.length === 0) return;
    const now = Date.now();
    const rangeMs = rangeHours * 3_600_000;
    const nPoints = rangePoints ?? csvLines[0]?.values.length ?? 72;
    const stepMs = rangeMs / nPoints;
    const header = ["timestamp", ...csvLines.map((l) => l.name)].join(",");
    const rows = (csvLines[0]?.values ?? []).map((_, i) => {
      const ts = new Date(now - rangeMs + (i + 1) * stepMs).toISOString();
      const vals = csvLines.map((l) => {
        const v = l.values[i];
        return v == null ? "" : String(v);
      });
      return [ts, ...vals].join(",");
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.csv`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setCsvState("done");
    setTimeout(() => setCsvState("idle"), 1600);
  }, [csvLines, rangeHours, rangePoints, filename]);

  return (
    <span
      data-chart-export-button="true"
      className={`inline-flex items-center rounded-md border border-ink/15 bg-paper shadow-sm ${className}`}
    >
      <Hint label="Copy chart as PNG">
        <button
          type="button"
          onClick={onCopy}
          disabled={state === "working"}
          className="inline-flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] text-ink transition-colors hover:bg-paper-soft disabled:opacity-60"
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
            {state === "copied"
              ? "Copied"
              : state === "error"
                ? "Failed"
                : "Copy"}
          </span>
        </button>
      </Hint>
      <span aria-hidden className="h-4 w-px bg-ink/15" />
      <Hint label="Download PNG">
        <button
          type="button"
          onClick={onDownload}
          disabled={state === "working"}
          className={`inline-flex items-center gap-1.5 px-2 py-1 text-ink transition-colors hover:bg-paper-soft disabled:opacity-60 ${csvLines && csvLines.length > 0 ? "" : "rounded-r-md"}`}
          aria-label="Download chart as PNG"
        >
          {state === "downloaded" ? (
            <Check size={11} strokeWidth={2.4} />
          ) : (
            <Download size={11} strokeWidth={2} />
          )}
        </button>
      </Hint>
      {csvLines && csvLines.length > 0 && (
        <>
          <span aria-hidden className="h-4 w-px bg-ink/15" />
          <Hint label="Download CSV">
            <button
              type="button"
              onClick={onDownloadCsv}
              className="inline-flex items-center gap-1.5 rounded-r-md px-2 py-1 text-ink transition-colors hover:bg-paper-soft"
              aria-label="Download chart data as CSV"
            >
              {csvState === "done" ? (
                <Check size={11} strokeWidth={2.4} />
              ) : (
                <FileText size={11} strokeWidth={2} />
              )}
            </button>
          </Hint>
        </>
      )}
    </span>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.png`;
  // Safari occasionally aborts programmatic downloads if the object URL
  // is revoked before the browser processes the click. Give it a full
  // second before releasing the URL.
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
