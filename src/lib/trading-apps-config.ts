export type AppMeta = {
  id: string;
  name: string;
  category: "meme-bot" | "telegram-bot";
  logoKey: string | null;
  productUrl: string;
  benchUrl: string | null;
  evmKey: string | null;
  solanaKey: string | null;
};

export const TRADING_APPS: AppMeta[] = [
  { id: "pump.fun", name: "pump.fun", category: "meme-bot", logoKey: "pump-fun", productUrl: "https://pump.fun", benchUrl: "/benchmarks/trading-app-execution", evmKey: "pumpfun", solanaKey: "pump.fun" },
  { id: "fomo", name: "FOMO", category: "meme-bot", logoKey: "fomo", productUrl: "https://fomo.fund", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "fomo" },
  { id: "bullx", name: "BullX", category: "meme-bot", logoKey: "bullx", productUrl: "https://bullx.io", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "bullx" },
  { id: "photon", name: "Photon", category: "meme-bot", logoKey: "photon", productUrl: "https://photon-sol.tinyastro.io", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "photon" },
  { id: "gmgn", name: "GMGN", category: "telegram-bot", logoKey: "gmgn", productUrl: "https://gmgn.ai", benchUrl: "/benchmarks/trading-app-execution", evmKey: "gmgn", solanaKey: "gmgn" },
  { id: "axiom", name: "Axiom", category: "telegram-bot", logoKey: "axiom", productUrl: "https://axiom.trade", benchUrl: "/benchmarks/trading-app-execution", evmKey: "axiom", solanaKey: "axiom" },
  { id: "maestro", name: "Maestro", category: "telegram-bot", logoKey: "maestro", productUrl: "https://maestro.bots.gg", benchUrl: "/benchmarks/trading-app-execution", evmKey: "maestro", solanaKey: "maestro" },
  { id: "banana-gun", name: "Banana Gun", category: "telegram-bot", logoKey: "banana-gun", productUrl: "https://t.me/BananaGunSniper_bot", benchUrl: "/benchmarks/trading-app-execution", evmKey: "banana-gun", solanaKey: "banana-gun" },
  { id: "trojan", name: "Trojan", category: "telegram-bot", logoKey: "trojan", productUrl: "https://trojan.bot", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "trojan" },
];
