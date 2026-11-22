"use client";

import { useEffect, useMemo, useState } from "react";
import { liveResults } from "@/lib/provider-filters";
import {
  VENUE_TYPE_PARAM,
  parseVenueTypeView,
  shownVenueTypeView,
  venueTypeCounts,
  type VenueTypeView,
} from "@/lib/venue-type-filter";
import type { Benchmark } from "@/types/benchmark";

type VenueTypeViewState = {
  view: VenueTypeView;
  counts: ReturnType<typeof venueTypeCounts>;
  showRow: boolean;
  select: (raw: string) => void;
};

export function useVenueTypeView(
  benchmark: Benchmark,
  urlValue: string | null,
): VenueTypeViewState {
  const [picked, setPicked] = useState<VenueTypeView>(
    parseVenueTypeView(urlValue),
  );
  const counts = useMemo(
    () => venueTypeCounts(liveResults(benchmark.results)),
    [benchmark],
  );
  const view = shownVenueTypeView(picked, counts);
  const showRow = (counts.dex > 0 && counts.cex > 0) || view !== "all";

  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "all") url.searchParams.delete(VENUE_TYPE_PARAM);
    else url.searchParams.set(VENUE_TYPE_PARAM, view);
    if (url.href === window.location.href) return;
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [view]);

  const select = (raw: string) => setPicked(parseVenueTypeView(raw));
  return { view, counts, showRow, select };
}
