/**
 * The site's dark palette and type stack, copied from src/app/globals.css so
 * the film and the site cannot drift apart. The fonts are the same woff2
 * files the site ships, carried in public/fonts rather than fetched, so a
 * render on a headless box cannot silently fall back to a system face.
 */

export const C = {
  paper: "#0a0b0d",
  paperSoft: "#181a1f",
  surface: "#15171c",
  ink: "#f8fafc",
  inkSoft: "#d6dee8",
  inkMuted: "#a3b0c2",
  inkFaint: "#8290a3",
  rule: "#2a2f38",
  ruleStrong: "#3a4150",
  good: "#34d399",
  bad: "#fb7185",
  warn: "#fbbf24",
  accent: "#fb923c",
  accentSoft: "#2d1a0e",
} as const;

export const F = {
  display: '"Inter Tight", Inter, system-ui, sans-serif',
  sans: "Inter, system-ui, sans-serif",
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

export const FPS = 30;
export const W = 1920;
export const H = 1080;
