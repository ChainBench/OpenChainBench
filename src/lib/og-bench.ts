import { getBenchmark } from "@/data/benchmarks";
import {
  parseVenueTypeView,
  scopeToVenueType,
  type VenueTypeView,
} from "@/lib/venue-type-filter";
import type { Benchmark } from "@/types/benchmark";

type OgBench = { view: VenueTypeView; bench: Benchmark | undefined };

export async function loadOgBench(
  slug: string,
  rawView: string | null,
): Promise<OgBench> {
  const view = parseVenueTypeView(rawView);
  return { view, bench: scopeToVenueType(await getBenchmark(slug), view) };
}
