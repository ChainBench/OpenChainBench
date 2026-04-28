/**
 * Per-provider color assignment.
 *
 * Each provider slug maps to a stable hex used as text color and (with low
 * alpha) as bar fill / pill background. New slugs fall back to a neutral
 * gray; add an entry below to give them their own hue.
 */

export const PROVIDER_COLORS: Record<string, string> = {
  // Aggregator-head-lag
  mobula: "#6b3def",
  codex: "#e64ba8",
  geckoterminal: "#14b8a6",

  // Bridge providers
  relay: "#ea580c",
  lifi: "#f59e0b",
  debridge: "#dc2626",

  // DEX-aggregator providers (other names retained for future benches)
  jupiter: "#06b6d4",
  kyberswap: "#16a34a",
  paraswap: "#2563eb",
  openocean: "#0ea5e9",
  "1inch": "#52525b",
  "0x": "#171717",

  // RPC providers
  alchemy: "#8b5cf6",
  quicknode: "#ec4899",
  infura: "#f97316",
  ankr: "#0d9488",
  tenderly: "#b91c1c",

  // Other Mobula sub-products (in case of slug collisions)
  "mobula-bridge": "#6b3def",
  "mobula-rpc": "#6b3def",
  "mobula-api": "#6b3def",
};

const DEFAULT_COLOR = "#525252";

export function providerColor(slug: string): string {
  return PROVIDER_COLORS[slug] ?? DEFAULT_COLOR;
}

/** Tailwind-compatible style: `{ color: hex }` */
export function colorStyle(slug: string): { color: string } {
  return { color: providerColor(slug) };
}

/** Background style with low opacity for pill fills. */
export function fillStyle(slug: string, alpha = 0.12): { backgroundColor: string } {
  const hex = providerColor(slug);
  return { backgroundColor: hexWithAlpha(hex, alpha) };
}

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}
