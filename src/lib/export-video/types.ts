/**
 * Shape the video renderer consumes. Mirrors the BenchPayload type
 * exported by the standalone POC at github.com/Flotapponnier/openbench_video_generator
 * — kept in sync so renderer requests are a flat JSON pass-through.
 */

export type ProviderSeries = {
  slug: string;
  name: string;
  /** Brand color hex (e.g. "#22c55e"). */
  color: string;
  /** Optional public-relative logo path (e.g. "/logos/mobula.svg"). */
  logo?: string;
  /** One value per timestamp; length must equal `timestamps.length`. */
  values: number[];
};

export type BenchPayload = {
  slug: string;
  title: string;
  metric: string;
  unit: string;
  higherIsBetter: boolean;
  /** Bucket starts in ms-epoch. */
  timestamps: number[];
  providers: ProviderSeries[];
};

export type RangeId = "24h" | "7d" | "30d" | "90d" | "1y";
export const RANGE_IDS: RangeId[] = ["24h", "7d", "30d", "90d", "1y"];
export const RANGE_LABEL: Record<RangeId, string> = {
  "24h": "Last 24h",
  "7d": "Last 7d",
  "30d": "Last 30d",
  "90d": "Last 90d",
  "1y": "Last year",
};

export type ViewId =
  | "BarChartRace"
  | "TimeSeriesRace"
  | "DistributionRace"
  | "DonutRace"
  | "CountPodium";
export const VIEW_IDS: ViewId[] = [
  "BarChartRace",
  "TimeSeriesRace",
  "DistributionRace",
  "DonutRace",
  "CountPodium",
];
export const VIEW_LABEL: Record<ViewId, string> = {
  BarChartRace: "Ranked bars",
  TimeSeriesRace: "Time series",
  DistributionRace: "Distribution",
  DonutRace: "Donut",
  CountPodium: "Podium",
};

export type RenderState =
  | { status: "idle" }
  | { status: "loading_series" }
  | { status: "rendering"; startedAt: number }
  | { status: "done"; url: string; cached: boolean; ms: number }
  | { status: "error"; message: string };
