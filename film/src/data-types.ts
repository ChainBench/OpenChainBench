import type { FILM } from "./data";

/**
 * Shapes of the generated data, named so the acts can take a parameter instead
 * of reaching into the literal. `data.ts` is `as const`, which makes every
 * string a literal type; these aliases widen it back to something an act can
 * accept without the call site having to match 33 logo paths exactly.
 */

export type Act = {
  slug: string;
  category: string;
  categoryLine: string;
  claim: string;
  metric: string;
  shape: "lag" | "volume" | "fee" | "tempo";
  title: string;
  unit: string;
  higherIsBetter: boolean;
  ranked: number;
  benchesInCategory: number;
  field: ReadonlyArray<{
    name: string;
    slug: string;
    logo: string | null;
    raw: number;
    value: string;
    unit: string;
    rank: number;
  }>;
};

export type Film = typeof FILM;
