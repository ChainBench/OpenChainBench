import { readsCohortLeaders } from "@/lib/bench-template";
import { ProviderVenueType } from "@/lib/spec-schema";

type VenueScope = {
  venueType: unknown;
  bench: string;
  benchTypesProviders: boolean;
};

type TemplatedField = readonly [name: string, text: string | undefined];

type VenueScopeError = { field: string; message: string };

export function venueScopeErrors(
  scope: VenueScope,
  fields: readonly TemplatedField[],
): VenueScopeError[] {
  if (scope.venueType === undefined) return [];
  const parsed = ProviderVenueType.safeParse(scope.venueType);
  if (!parsed.success) {
    return [{ field: "venue_type", message: "must be dex or cex" }];
  }
  const bench = `bench "${scope.bench}"`;
  const rows = `${parsed.data.toUpperCase()} rows`;
  const unscoped = fields
    .filter(([, text]) => text !== undefined && readsCohortLeaders(text))
    .map(([field]) => ({
      field,
      message: `a chain or tier placeholder ranks every row of ${bench}, ` +
        `not only its ${rows}`,
    }));
  if (scope.benchTypesProviders) return unscoped;
  return [
    {
      field: "venue_type",
      message: `${bench} gives no provider a venue_type, ` +
        "so the page would rank no row",
    },
    ...unscoped,
  ];
}
