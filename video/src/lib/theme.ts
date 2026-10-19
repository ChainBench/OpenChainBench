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
