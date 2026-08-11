export type AppMeta = {
  id: string;
  name: string;
  category: "meme-bot" | "telegram-bot" | "perps";
  logoKey: string | null;
  productUrl: string;
  benchUrl: string | null;
  evmKey: string | null;
  solanaKey: string | null;
  perpsSlug: string | null;
};

export const TRADING_APPS: AppMeta[] = [
  { id: "pump.fun", name: "pump.fun", category: "meme-bot", logoKey: "pump-fun", productUrl: "https://pump.fun", benchUrl: null, evmKey: "pumpfun", solanaKey: "pump.fun", perpsSlug: null },
  { id: "fomo", name: "FOMO", category: "meme-bot", logoKey: "fomo", productUrl: "https://fomo.fund", benchUrl: null, evmKey: null, solanaKey: "fomo", perpsSlug: null },
  { id: "bullx", name: "BullX", category: "meme-bot", logoKey: null, productUrl: "https://bullx.io", benchUrl: null, evmKey: null, solanaKey: "bullx", perpsSlug: null },
  { id: "photon", name: "Photon", category: "meme-bot", logoKey: null, productUrl: "https://photon-sol.tinyastro.io", benchUrl: null, evmKey: null, solanaKey: "photon", perpsSlug: null },
  { id: "gmgn", name: "GMGN", category: "telegram-bot", logoKey: "gmgn", productUrl: "https://gmgn.ai", benchUrl: null, evmKey: "gmgn", solanaKey: "gmgn", perpsSlug: null },
  { id: "axiom", name: "Axiom", category: "telegram-bot", logoKey: "axiom", productUrl: "https://axiom.trade", benchUrl: null, evmKey: "axiom", solanaKey: "axiom", perpsSlug: null },
  { id: "maestro", name: "Maestro", category: "telegram-bot", logoKey: "maestro", productUrl: "https://maestro.bots.gg", benchUrl: null, evmKey: "maestro", solanaKey: null, perpsSlug: null },
  { id: "banana-gun", name: "Banana Gun", category: "telegram-bot", logoKey: null, productUrl: "https://t.me/BananaGunSniper_bot", benchUrl: null, evmKey: "banana-gun", solanaKey: null, perpsSlug: null },
  { id: "trojan", name: "Trojan", category: "telegram-bot", logoKey: "trojan", productUrl: "https://trojan.bot", benchUrl: null, evmKey: null, solanaKey: "trojan", perpsSlug: null },
  { id: "hyperliquid", name: "Hyperliquid", category: "perps", logoKey: "hyperliquid", productUrl: "https://hyperliquid.xyz", benchUrl: "/hyperliquid", evmKey: null, solanaKey: null, perpsSlug: "hyperliquid" },
  { id: "jupiter-perps", name: "Jupiter Perps", category: "perps", logoKey: "jupiter", productUrl: "https://jup.ag/perps", benchUrl: null, evmKey: null, solanaKey: null, perpsSlug: "jupiter-perps" },
  { id: "gmx", name: "GMX", category: "perps", logoKey: "gmx", productUrl: "https://gmx.io", benchUrl: null, evmKey: null, solanaKey: null, perpsSlug: "gmx" },
  { id: "dydx", name: "dYdX", category: "perps", logoKey: "dydx", productUrl: "https://dydx.exchange", benchUrl: null, evmKey: null, solanaKey: null, perpsSlug: "dydx" },
  { id: "gains-trade", name: "Gains.trade", category: "perps", logoKey: "gains", productUrl: "https://gains.trade", benchUrl: null, evmKey: null, solanaKey: null, perpsSlug: "gains-trade" },
  { id: "drift", name: "Drift", category: "perps", logoKey: "drift", productUrl: "https://drift.trade", benchUrl: null, evmKey: null, solanaKey: null, perpsSlug: "drift" },
  { id: "vertex", name: "Vertex", category: "perps", logoKey: "vertex", productUrl: "https://vertexprotocol.com", benchUrl: null, evmKey: null, solanaKey: null, perpsSlug: "vertex" },
];
