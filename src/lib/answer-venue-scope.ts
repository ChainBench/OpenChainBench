import { readsCohortLeaders } from "@/lib/bench-template";
import type { ProviderVenueType } from "@/types/benchmark";

type VenueScope = {
  venueType: ProviderVenueType;
  bench: string;
  benchTypesProviders: boolean;
};

type TemplatedField = readonly [name: string, text: string | undefined];

export function venueScopeErrors(
  scope: VenueScope,
  fields: readonly TemplatedField[],
): string[] {
  const bench = `bench "${scope.bench}"`;
  const rows = `${scope.venueType.toUpperCase()} rows`;
  const unscoped = fields
    .filter(([, text]) => text !== undefined && readsCohortLeaders(text))
    .map(
      ([name]) =>
        `${name}: a chain or tier placeholder ranks every row of ` +
        `${bench}, not only its ${rows}`,
    );
  if (scope.benchTypesProviders) return unscoped;
  return [
    `venue_type is ${scope.venueType} but ${bench} gives no provider ` +
      "a venue_type, so the answer would rank no row",
    ...unscoped,
  ];
}
