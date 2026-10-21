/**
 * Theme tokens shared across every bench composition. Mirror the
 * OpenChainBench site palette so the videos read as the same product.
 * Only the dark theme ships for now; if a light pass is needed later,
 * fork this file rather than branching every call site.
 */

export type Theme = {
  background: string;
  surface: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  inkFaint: string;
  rule: string;
  ruleStrong: string;
  barTrack: string;
  accent: string;
};

export const DARK_THEME: Theme = {
  background: "#000000",
  surface: "#15171c",
  ink: "#f8fafc",
  inkSoft: "#d6dee8",
  inkMuted: "#a3b0c2",
  inkFaint: "#8290a3",
  rule: "#2a2f38",
  ruleStrong: "#3a4150",
  barTrack: "#181a1f",
  accent: "#fb923c",
};

export const LIGHT_THEME: Theme = {
  background: "#ffffff",
  surface: "#ffffff",
  ink: "#0f172a",
  inkSoft: "#334155",
  inkMuted: "#64748b",
  inkFaint: "#6e7c8e",
  rule: "#e2e8f0",
  ruleStrong: "#cbd5e1",
  barTrack: "#f1f5f9",
  accent: "#ea580c",
};

export const themeFor = (mode: "light" | "dark"): Theme =>
  mode === "dark" ? DARK_THEME : LIGHT_THEME;

const hexRgb = (h: string): [number, number, number] | null => {
  let s = h.trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
};
const luminance = ([r, g, b]: [number, number, number]) => {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/**
 * A brand colour moved toward the ink until it reads on the background
 * (contrast >= 4:1, the level a 3 px line and a 20 px name both need).
 * Cardano's #0033AD drew a line nobody could see on #000.
 */
export function legibleColor(color: string, t: Theme, min = 4): string {
  const c = hexRgb(color), bg = hexRgb(t.background), ink = hexRgb(t.ink);
  if (!c || !bg || !ink || contrast(c, bg) >= min) return color;
  for (let k = 1; k <= 20; k++) {
    const m = c.map((v, i) => Math.round(v + ((ink[i] - v) * k) / 20)) as [number, number, number];
    if (contrast(m, bg) >= min) return "#" + m.map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  return t.ink;
}

/** Hue of a hex colour turned by `deg` degrees (HSL), or the input when unparsable. */
function rotateHue(color: string, deg: number): string {
  const c = hexRgb(color);
  if (!c) return color;
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + deg + 360) % 360;
  const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - C / 2;
  const [R, G, B] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return "#" + [R, G, B].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * The bench with every provider colour made legible on this theme, and
 * no two providers sharing one: rpc-cluster-12 had three pairs of
 * identical brand colours, two lines nobody could tell apart. A repeat
 * turns its hue until it is free.
 */
export function legibleBench<B extends { providers: { color: string }[] }>(bench: B, t: Theme): B {
  const used = new Set<string>();
  const providers = bench.providers.map((p) => {
    let c = legibleColor(p.color, t);
    for (let k = 1; used.has(c.toLowerCase()) && k < 10; k++) c = legibleColor(rotateHue(p.color, 36 * k), t);
    used.add(c.toLowerCase());
    return { ...p, color: c };
  });
  return { ...bench, providers };
}
