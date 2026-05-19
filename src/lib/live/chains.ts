/**
 * Per-chain metadata used by the live dashboard: display name, logo slug,
 * and brand color for chart polylines. The aliases map covers the various
 * names the relay can emit (server-side blockchain field comes in several
 * casings).
 */

export type ChainMeta = {
  key: string;
  slug: string;
  display: string;
  color: string;
};

export const CHAIN_LIST: ChainMeta[] = [
  { key: "ethereum", slug: "ethereum", display: "Ethereum", color: "#627EEA" },
  { key: "solana", slug: "solana", display: "Solana", color: "#9945FF" },
  { key: "base", slug: "base", display: "Base", color: "#0052FF" },
  { key: "bnb", slug: "bnb", display: "BNB", color: "#F0B90B" },
  { key: "arbitrum", slug: "arbitrum", display: "Arbitrum", color: "#28A0F0" },
  { key: "optimism", slug: "optimism", display: "Optimism", color: "#FF0420" },
  { key: "polygon", slug: "polygon", display: "Polygon", color: "#8247E5" },
  { key: "avalanche", slug: "avalanche", display: "Avalanche", color: "#E84142" },
  { key: "linea", slug: "linea", display: "Linea", color: "#61DFFF" },
  { key: "mantle", slug: "mantle", display: "Mantle", color: "#79EAA1" },
  { key: "blast", slug: "blast", display: "Blast", color: "#FCFC03" },
  { key: "scroll", slug: "scroll", display: "Scroll", color: "#C78F50" },
  { key: "zksync", slug: "zksync", display: "zkSync Era", color: "#8C8DFC" },
  { key: "sonic", slug: "sonic", display: "Sonic", color: "#FE9933" },
  { key: "berachain", slug: "berachain", display: "Berachain", color: "#814625" },
];

const BY_INPUT: Record<string, ChainMeta> = (() => {
  const m: Record<string, ChainMeta> = {};
  for (const c of CHAIN_LIST) {
    m[c.key] = c;
    m[c.display] = c;
    m[c.display.toLowerCase()] = c;
  }
  const bnb = CHAIN_LIST.find((c) => c.key === "bnb")!;
  m.bsc = bnb;
  m.BSC = bnb;
  m["BNB Smart Chain"] = bnb;
  m["BNB Smart Chain (BEP20)"] = bnb;
  return m;
})();

export function chainMeta(raw: string | undefined): ChainMeta | null {
  if (!raw) return null;
  return BY_INPUT[raw] ?? null;
}
