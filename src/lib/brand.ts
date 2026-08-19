/**
 * Brand colors for chains and well-known providers, used to keep series
 * colors consistent across charts, leaderboards and exported share cards.
 *
 * Lookup is slug-based and case-insensitive. Anything not in this table
 * falls back to the rotating editorial palette in `series-colors.ts`.
 *
 * Sources: official brand kits and press pages. Kept conservative - we
 * only declare a brand color when it's unambiguous. Add a logo asset at
 * `public/logos/<slug>.svg` and the `<ProviderLogo>` component picks it
 * up automatically.
 */

export type Brand = {
  color: string;
  /** Whether the brand color is dark - picked by Logo to flip its text color. */
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
  starknet: { color: "#EC796B" },
  gram: { color: "#30A1F5" },
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

  // ─── Region pseudo-brands (used by the dimension tabs alongside chains) ───
  "us-east": { color: "#C7833A" },
  "eu-west": { color: "#3A7BC7" },
  "ap-southeast": { color: "#3F8F66" },
  // `sgp` is the raw Railway region label emitted by the harnesses; the bench
  // YAML uses it as the dimension value, so we alias the same color here so
  // the region tab gets a globe glyph + colored ring instead of a no-brand
  // fallback.
  sgp: { color: "#3F8F66" },
  global: { color: "#7a7166" },

  // ─── Aggregators / providers (bright, saturated - read on both modes) ───
  mobula: { color: "#FF6B35" },        // vivid orange
  codex: { color: "#84cc16" },         // saturated lime - readable on white + dark
  geckoterminal: { color: "#8B5CF6" }, // vivid violet (gecko brand)
  jupiter: { color: "#C7F284" },       // jupiter matrix green (secondary brand) - keeps it
                                       //   distinct from mobula's orange on solana-dex-quote
  raydium: { color: "#00C2FF" },       // raydium cyan
  openocean: { color: "#2563EB" },     // openocean deep blue
  helius: { color: "#FF4D8D" },        // hot pink (helius brand)
  moralis: { color: "#5B89FF" },       // azure
  blockscout: { color: "#3DD7C8" },    // bright cyan
  tonapi: { color: "#26A4F2" },        // ton-blue
  stellarexpert: { color: "#00D1FF" }, // electric sky
  xrpscan: { color: "#42B9F5" },       // bright sky
  oli: { color: "#FFC857" },           // sun yellow
  walletexplorer: { color: "#F5A623" },// gold

  // ─── Bridges / relays ───
  debridge: { color: "#FFB347" },      // pumpkin
  lifi: { color: "#F5C518" },          // saturated yellow
  relay: { color: "#26D49B" },         // mint
  across: { color: "#6CF9D8" },        // across aqua

  // ─── Solana DEX platforms (bench № 205) ───
  pumpswap: { color: "#00C851" },      // pump.fun green (shares brand)
  axiom: { color: "#6EE7B7" },         // axiom mint
  photon: { color: "#8B5CF6" },        // photon violet
  trojan: { color: "#EF4444" },        // trojan red
  gmgn: { color: "#3B82F6" },          // gmgn blue
  bullx: { color: "#F59E0B" },         // bullx amber

  // ─── Crypto trading apps (bench № 202) ───
  invo: { color: "#7B5EA7" },          // invo purple
  robinhood: { color: "#00C805" },     // robinhood green
  cryptocom: { color: "#002D74", dark: true }, // crypto.com navy
  "pump-fun": { color: "#00C851" },    // pump.fun green
  moonshot: { color: "#F97316" },      // moonshot orange
  fomo: { color: "#7C3AED" },          // fomo violet
  coinbase: { color: "#0052FF" },      // coinbase blue
  bybit: { color: "#F7A600" },         // bybit yellow
  kraken: { color: "#5741D9" },        // kraken purple
  "binance-us": { color: "#F0B90B" },  // binance yellow

  // ─── Non-EVM L1s (benches 211-214) ───
  aptos: { color: "#00C4FF" },       // aptos cyan (brand kit)
  algorand: { color: "#000000" },    // algorand black (official brand)

  // ─── New RPC providers (benches 214-215) ───
  tatum: { color: "#4F37FD" },       // tatum purple
  uniblock: { color: "#1FB6FF" },    // uniblock cyan
  nodely: { color: "#F9B72B" },      // nodely amber

  // ─── Non-EVM L1s wave 2 (benches 216-221) ───
  near: { color: "#00C27E" },        // near green (official brand)
  flow: { color: "#00EF8B" },        // flow green (primary brand)
  hedera: { color: "#222222", dark: true }, // hedera dark (official brand)
  ckb: { color: "#3CC68A" },         // nervos ckb teal
  multiversx: { color: "#23F7DD" },  // multiversx teal/cyan
  neo: { color: "#00AF92" },         // neo teal (brand kit)

  // ─── New providers (benches 216-221) ───
  fastnear: { color: "#00C27E" },    // fastnear inherits near green
  hashio: { color: "#222222", dark: true }, // hashio inherits hedera dark
  "ckb-dev": { color: "#3CC68A" },   // nervos foundation teal
  ckbapp: { color: "#3CC68A" },      // ckbapp teal
  "mvx-gateway": { color: "#23F7DD" }, // multiversx teal
  "mvx-api": { color: "#23F7DD" },   // multiversx teal
  nspcc: { color: "#1565C0", dark: true }, // nspcc deep blue
  ngd: { color: "#00AF92" },         // ngd inherits neo teal
  ngd2: { color: "#00AF92" },        // ngd2 inherits neo teal
  onflow: { color: "#00EF8B" },      // onflow inherits flow green
  "flow-access": { color: "#00EF8B" }, // flow access inherits flow green
  "near-org": { color: "#00C27E" },  // near foundation inherits near green

  // ─── New RPC chains (benches 222-231) ───
  tezos:      { color: "#2C7DF7" },        // tezos blue (official brand kit)
  eos:        { color: "#453F61" },        // eos dark purple
  vechain:    { color: "#2C4CD8" },        // vechain blue
  waves:      { color: "#0055FF" },        // waves blue
  wax:        { color: "#F89422" },        // wax amber-orange
  neon:       { color: "#9333EA" },        // neon evm purple
  merlin:     { color: "#F7A400" },        // merlin amber (bitcoin l2 vibe)
  viction:    { color: "#1D61DE" },        // viction blue (ex-tomochain)
  thundercore: { color: "#002868", dark: true }, // thundercore dark blue
  oktc:       { color: "#101010", dark: true },  // okx/oktc dark

  // ─── New providers (benches 222-231) ───
  ecadinfra:         { color: "#2C7DF7" }, // tezos blue
  tzbeta:            { color: "#2C7DF7" }, // tezos blue
  tzkt:              { color: "#2C7DF7" }, // tezos blue
  greymass:          { color: "#453F61" }, // eos purple
  eosnation:         { color: "#453F61" }, // eos purple
  alohaeos:          { color: "#453F61" }, // eos purple
  "vechain-foundation": { color: "#2C4CD8" }, // vechain blue
  "vethor-node":     { color: "#2C4CD8" }, // vechain blue
  "vechain-energy":  { color: "#2C4CD8" }, // vechain blue
  wavesnodes:        { color: "#0055FF" }, // waves blue
  "wx-network":      { color: "#0055FF" }, // waves blue
  "waves-exchange":  { color: "#0055FF" }, // waves blue
  eosusa:            { color: "#F89422" }, // wax orange
  waxsweden:         { color: "#F89422" }, // wax orange
  "neon-p2p":        { color: "#9333EA" }, // neon purple
  everstake:         { color: "#00D4AA" }, // everstake teal
  "merlin-official": { color: "#F7A400" }, // merlin amber
  blockpi:           { color: "#3D5CFF" }, // blockpi blue
  "viction-official":    { color: "#1D61DE" }, // viction blue
  "viction-rpc2":    { color: "#1D61DE" }, // viction blue (secondary node)
  "thundercore-official": { color: "#002868", dark: true }, // thundercore dark
  thundertoken:      { color: "#002868", dark: true }, // thundercore dark (thundertoken node)
  smartpy:           { color: "#2C7DF7" }, // smartpy blue (tezos ecosystem)
  "oktc-official":   { color: "#101010", dark: true }, // okx dark

  // ─── Stellar ecosystem providers (bench № 210) ───
  gateway: { color: "#00C2A8" },        // gateway.fm teal
  sorobanrpc: { color: "#7B4FBF" },     // sorobanrpc violet
  lightsail: { color: "#3AABFF" },      // lightsail sky blue

  // ─── Trading / perps ───
  hyperliquid: { color: "#22D3EE" },   // cyan
  dydx: { color: "#C084FC" },          // bright violet
  gmx: { color: "#4F8BFF" },           // royal blue
  lighter: { color: "#FF2E63" },       // hot magenta
  gains: { color: "#10E2A4" },         // emerald

};

const REGION_VALUES = new Set(["us-east", "eu-west", "ap-southeast", "sgp", "global"]);

/** Is this slug a region value? Region tabs render with a unified globe
 *  glyph instead of a per-entity logo, so callers can branch on this. */
export function isRegion(slug: string): boolean {
  return REGION_VALUES.has(key(slug));
}

function key(slug: string): string {
  return slug.toLowerCase();
}

/** Return the brand color for a slug, or null if none is registered. */
export function brandColor(slug: string): string | null {
  return BRANDS[key(slug)]?.color ?? null;
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

/** Perceived-luminance check used to pick a contrasting label color on top
 * of the brand chip. Threshold tuned so yellows/oranges read as light
 * (ink text) and saturated blues/reds as dark (paper text). */
function isLight(hex: string): boolean {
  const c = hex.replace("#", "");
  if (c.length !== 6) return false;
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** Resolve the on-chip text color for a slug's brand. Returns hex/var
 * suitable for inline style. Defaults to paper (light) when no brand. */
export function chipTextColor(slug: string): string {
  const color = BRANDS[key(slug)]?.color;
  if (!color) return "var(--color-paper)";
  return isLight(color) ? "var(--color-ink)" : "var(--color-paper)";
}

/** Background for the chip fallback. Falls back to ink so the chip still
 * reads as a coherent element even with no brand entry. */
export function chipBackground(slug: string): string {
  return BRANDS[key(slug)]?.color ?? "var(--color-ink-soft)";
}
