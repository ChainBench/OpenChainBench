/**
 * Brand colors for chains and well-known providers, used to keep series
 * colors consistent across charts, leaderboards and exported share cards.
 *
 * Lookup is slug-based and case-insensitive. Anything not in this table
 * falls back to the rotating editorial palette in `series-colors.ts`.
 *
 * Sources: official brand kits and press pages. Kept conservative — we
 * only declare a brand color when it's unambiguous. Add a logo asset at
 * `public/logos/<slug>.svg` and the `<ProviderLogo>` component picks it
 * up automatically.
 */

export type Brand = {
  color: string;
  /** Whether the brand color is dark — picked by Logo to flip its text color. */
  dark?: boolean;
};

const BRANDS: Record<string, Brand> = {
  // ─── L1 chains ───
  ethereum: { color: "#627EEA" },
  solana: { color: "#9945FF" },
  bnb: { color: "#F0B90B" },
  avalanche: { color: "#E84142" },
  tron: { color: "#E50914" },
  sui: { color: "#4DA2FF" },
  stellar: { color: "#08B5E5" },
  ton: { color: "#0098EA" },
  cardano: { color: "#0033AD", dark: true },
  litecoin: { color: "#345D9D", dark: true },
  monero: { color: "#FF6600" },
  bitcoin: { color: "#F7931A" },
  xrp: { color: "#0085C3" },

  // ─── EVM L2s & sidechains ───
  base: { color: "#0052FF" },
  arbitrum: { color: "#28A0F0" },
  polygon: { color: "#8247E5" },
  optimism: { color: "#FF0420" },

  // ─── Trading-pair "chains" (perp-fees uses asset symbols) ───
  eth: { color: "#627EEA" },
  btc: { color: "#F7931A" },
};

function key(slug: string): string {
  return slug.toLowerCase();
}

/** Return the brand color for a slug, or null if none is registered. */
export function brandColor(slug: string): string | null {
  return BRANDS[key(slug)]?.color ?? null;
}

/** Whether the brand color is dark enough that overlaid text should be light. */
export function brandIsDark(slug: string): boolean {
  return BRANDS[key(slug)]?.dark === true;
}

/** Two-letter initials used by the fallback colored chip when no SVG logo
 * is present in `public/logos/`. */
export function initials(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
