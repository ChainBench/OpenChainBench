import { useEffect, useMemo, useRef } from "react";
import { continueRender, delayRender, getInputProps, useCurrentFrame } from "remotion";

/**
 * Lab-only layout probe. When the lab renders a still with
 * `inputProps.lab === true`, this measures what the frame actually shows
 * (every visible text run, every logo) and prints it as one console line
 * that lab/stills.mjs captures. lab/checks.mjs turns it into PASS/FAIL.
 * Production renders never set `lab`, so this renders nothing there.
 */

type Box = { x: number; y: number; w: number; h: number };

function effectiveOpacity(el: Element | null): number {
  let o = 1;
  for (let e = el; e && e instanceof HTMLElement; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || cs.display === "none") return 0;
    o *= Number(cs.opacity);
  }
  return o;
}

// Intersect a box with every overflow-clipping ancestor, so digits of a
// rolling number that sit outside their window are not counted as text.
function clipBox(el: Element, b: Box): Box | null {
  let { x, y, w, h } = b;
  for (let e = el.parentElement; e; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.overflow === "visible" && cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    const r = e.getBoundingClientRect();
    const nx = Math.max(x, r.left), ny = Math.max(y, r.top);
    const nr = Math.min(x + w, r.right), nb = Math.min(y + h, r.bottom);
    if (nr <= nx || nb <= ny) return null;
    x = nx; y = ny; w = nr - nx; h = nb - ny;
  }
  return { x, y, w, h };
}

function measure(root: HTMLElement | null) {
  const texts: unknown[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = (n.textContent ?? "").trim();
    const el = n.parentElement;
    // Odometer digits are one value, measured whole below.
    if (!s || !el || el.closest("[data-lab-probe]") || el.closest("[data-lab-value]")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const cs = getComputedStyle(el);
    const op = Number(effectiveOpacity(el).toFixed(2));
    // One item per rendered line: a wrapped title's bounding box would
    // otherwise cover whatever sits beside its shorter second line.
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const box = { x: r.left, y: r.top, w: r.width, h: r.height };
      texts.push({ t: s.slice(0, 80), box, vis: clipBox(el, box), op, fs: parseFloat(cs.fontSize), color: cs.color });
    }
  }
  document.querySelectorAll("[data-lab-value]").forEach((el) => {
    const r = el.getBoundingClientRect();
    const box = { x: r.left, y: r.top, w: r.width, h: r.height };
    texts.push({
      t: el.getAttribute("data-lab-value") ?? "",
      val: true,
      // Odometer wheels caught between two digits (RollingNumber).
      midRoll: Array.from(el.querySelectorAll<HTMLElement>("span > span[style*=translateY]")).filter((w) => {
        const m = /translateY\((-?[\d.]+)px\)/.exec(w.style.transform);
        // CSS height, not the box: the Ken Burns scale makes the box ~2% taller.
        const h = parseFloat(w.parentElement?.style.height ?? "") || 0;
        if (!m || h <= 0) return false;
        const frac = Math.abs(Number(m[1]) / h) % 1;
        return frac > 0.08 && frac < 0.92;
      }).length,
      box,
      vis: clipBox(el, box),
      op: Number(effectiveOpacity(el).toFixed(2)),
      fs: parseFloat(getComputedStyle(el).fontSize),
      color: getComputedStyle(el).color,
    });
  });
  const logos: unknown[] = [];
  document.querySelectorAll("[data-lab-chip]").forEach((el) => {
    const r = el.getBoundingClientRect();
    const img = el.querySelector("img");
    logos.push({
      name: el.getAttribute("data-lab-name"),
      kind: el.getAttribute("data-lab-chip"),
      src: img?.getAttribute("src") ?? null,
      loaded: img ? img.complete && img.naturalWidth > 0 : null,
      box: { x: r.left, y: r.top, w: r.width, h: r.height },
      op: Number(effectiveOpacity(el).toFixed(2)),
    });
  });
  // Coordinates relative to the composition's own box. Measured right
  // after React commits, Remotion sometimes still holds the tree a million
  // pixels off screen (y = -999673); page coordinates then read as text
  // past the frame edge on every label.
  const R = root?.getBoundingClientRect();
  const ox = R?.left ?? 0, oy = R?.top ?? 0;
  const shift = (b: Box | null) => (b ? { x: b.x - ox, y: b.y - oy, w: b.w, h: b.h } : null);
  for (const t of texts as { box: Box; vis: Box | null }[]) {
    t.box = shift(t.box)!;
    t.vis = shift(t.vis);
  }
  for (const l of logos as { box: Box }[]) l.box = shift(l.box)!;
  return { w: R?.width || window.innerWidth, h: R?.height || window.innerHeight, texts, logos };
}

export const LabProbe: React.FC = () => {
  // One measurement per rendered frame: stills render one frame, and the
  // motion pass (lab/motion.mjs) renders whole clips through renderMedia,
  // which forwards every console line with the frame number in it.
  const frame = useCurrentFrame();
  const ref = useRef<HTMLDivElement>(null);
  const handle = useMemo(() => delayRender("lab-probe " + frame), [frame]);
  useEffect(() => {
    let tries = 0;
    let alive = true;
    let cleared = false;
    const clear = () => {
      if (!cleared) continueRender(handle);
      cleared = true;
    };
    const tick = () => {
      if (!alive) return;
      // Wait for logos (Remotion's <Img> holds its own delayRender) and
      // fonts, then two animation frames. Measuring right after React's
      // commit read an intermediate layout (titles on top of rows) that is
      // not the frame Chrome paints; the motion pass is fast enough with
      // one browser per clip (lab/motion.mjs).
      const pending = Array.from(document.images).some((i) => !i.complete);
      if ((pending || document.fonts.status !== "loaded") && tries++ < 60) {
        setTimeout(tick, 50);
        return;
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (alive) console.log("LABPROBE " + JSON.stringify({ f: frame, ...measure(ref.current?.parentElement ?? null) }));
          clear();
        }),
      );
    };
    tick();
    return () => {
      alive = false;
      clear();
    };
  }, [frame, handle]);
  return <div ref={ref} data-lab-probe="" style={{ display: "none" }} />;
};

/** Wrap a composition so lab stills carry the probe. */
export function withLabProbe<P extends object>(C: React.ComponentType<P>): React.FC<P> {
  const lab = (getInputProps() as { lab?: boolean }).lab === true;
  if (!lab) return C as React.FC<P>;
  const Wrapped: React.FC<P> = (props) => (
    <>
      <C {...props} />
      <LabProbe />
    </>
  );
  return Wrapped;
}
