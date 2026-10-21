/**
 * The shape every composition and every API route consumes. Kept in a
 * `types/` folder (not under any specific composition) so the conceptual
 * model is independent of any single feature — mock fixtures live in
 * `lib/mock-data.ts`, the live OCB adapter lives in `lib/sources/`, both
 * implement this interface.
 */

export type ProviderSeries = {
  slug: string;
  name: string;
  /** Brand colour (hex). Falls back to an editorial palette when missing. */
  color: string;
  /** Relative path under /public, e.g. `logos/mobula.svg`. Optional. */
  logo?: string;
  /** One value per timestamp, length must equal payload.timestamps.length. */
  values: number[];
};

export type BenchPayload = {
  slug: string;
  title: string;
  metric: string;
  unit: string;
  /** When true, the visual sort puts higher values at the top. */
  higherIsBetter: boolean;
  /** Bucket starts in ms-epoch, length must equal each provider's values. */
  timestamps: number[];
  providers: ProviderSeries[];
};

export type ThemeMode = "light" | "dark";

export const THEME_MODES = ["light", "dark"] as const;

/** Range identifier used by the export modal + honest-data fetch. */
export type RangeId = "24h" | "7d" | "30d";

export const RANGE_IDS: RangeId[] = ["24h", "7d", "30d"];

export const RANGE_LABEL: Record<RangeId, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/**
 * The range carried in modal state. Either a relative preset (most users)
 * or an absolute [from, to] window in epoch ms (power users). Compositions
 * never see this — they consume the already-sliced `BenchPayload`.
 */
export type RangeSelection =
  | { type: "preset"; preset: RangeId }
  | { type: "custom"; from: number; to: number };

/** View identifier — one per composition the renderer exposes. */
export type ViewId =
  | "BarChartRace"
  | "TimeSeriesRace"
  | "DonutRace"
  | "CountPodium";

export const VIEW_IDS: ViewId[] = [
  "BarChartRace",
  "TimeSeriesRace",
  "DonutRace",
  "CountPodium",
];
