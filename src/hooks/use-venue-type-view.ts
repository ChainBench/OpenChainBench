"use client";

import { useEffect, useMemo, useState } from "react";
import { liveResults } from "@/lib/provider-filters";
import {
  VENUE_TYPE_PARAM,
  parseVenueTypeView,
  venueTypeCounts,
  type VenueTypeView,
} from "@/lib/venue-type-filter";
import type { Benchmark } from "@/types/benchmark";

export function useVenueTypeView(
  benchmark: Benchmark | undefined,
  urlValue: string | null,
) {
  const [picked, setPicked] = useState<VenueTypeView>(
    parseVenueTypeView(urlValue),
  );
  const counts = useMemo(
    () => venueTypeCounts(liveResults(benchmark?.results ?? [])),
    [benchmark],
  );
  const view: VenueTypeView = counts.dex + counts.cex > 0 ? picked : "all";
  const showRow = (counts.dex > 0 && counts.cex > 0) || view !== "all";

  const loaded = benchmark !== undefined;
  useEffect(() => {
    if (!loaded) return;
    const url = new URL(window.location.href);
    if (view === "all") url.searchParams.delete(VENUE_TYPE_PARAM);
    else url.searchParams.set(VENUE_TYPE_PARAM, view);
    if (url.href === window.location.href) return;
    const next = url.pathname + url.search + url.hash;
    window.history.replaceState(null, "", next);
  }, [loaded, view]);

  const select = (raw: string) => setPicked(parseVenueTypeView(raw));
  return { view, counts, showRow, select };
}
