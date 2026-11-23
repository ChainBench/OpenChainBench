import { loadBenchmark } from "@/lib/spec";
import { scopeToVenueType } from "@/lib/venue-type-filter";
import type { Benchmark, ProviderVenueType } from "@/types/benchmark";

type BenchPage = {
  benchmark: string;
  chain?: string;
  venue_type?: ProviderVenueType;
};

export async function loadScopedBench(
  page: BenchPage,
): Promise<Benchmark | undefined> {
  const bench = await loadBenchmark(page.benchmark, { chain: page.chain });
  return scopeToVenueType(bench, page.venue_type);
}
