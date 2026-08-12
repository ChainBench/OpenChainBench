export type AppMeta = {
  id: string;
  name: string;
  category: "trading-terminal" | "telegram-bot";
  logoKey: string | null;
  productUrl: string;
  benchUrl: string | null;
  evmKey: string | null;
  solanaKey: string | null;
  robinhoodKey: string | null;
  inactive?: boolean;
  inactiveSince?: string;
  /** When true, Solana fees are collected in USDC (6 dec raw units) not SOL lamports.
   *  Frontend uses sumPlatformFeeLamports / 1e6 directly instead of / 1e9 * solPrice. */
  solanaFeeIsUSDC?: boolean;
};

export const TRADING_APPS: AppMeta[] = [
  { id: "pump.fun", name: "pump.fun", category: "trading-terminal", logoKey: "pump-fun", productUrl: "https://pump.fun", benchUrl: "/benchmarks/trading-app-execution", evmKey: "pumpfun", solanaKey: "pump.fun", robinhoodKey: null },
  { id: "fomo", name: "FOMO", category: "trading-terminal", logoKey: "fomo", productUrl: "https://fomo.fund", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "fomo", robinhoodKey: null, solanaFeeIsUSDC: true },
  { id: "bullx", name: "BullX", category: "trading-terminal", logoKey: "bullx", productUrl: "https://bullx.io", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "bullx", robinhoodKey: null, inactive: true, inactiveSince: "2026-06-01" },
  { id: "photon", name: "Photon", category: "trading-terminal", logoKey: "photon", productUrl: "https://photon-sol.tinyastro.io", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "photon", robinhoodKey: null },
  { id: "gmgn", name: "GMGN", category: "telegram-bot", logoKey: "gmgn", productUrl: "https://gmgn.ai", benchUrl: "/benchmarks/trading-app-execution", evmKey: "gmgn", solanaKey: "gmgn", robinhoodKey: "gmgn-robinhood" },
  { id: "axiom", name: "Axiom", category: "telegram-bot", logoKey: "axiom", productUrl: "https://axiom.trade", benchUrl: "/benchmarks/trading-app-execution", evmKey: "axiom", solanaKey: "axiom", robinhoodKey: null },
  { id: "maestro", name: "Maestro", category: "telegram-bot", logoKey: "maestro", productUrl: "https://maestro.bots.gg", benchUrl: "/benchmarks/trading-app-execution", evmKey: "maestro", solanaKey: "maestro", robinhoodKey: "maestro-robinhood" },
  { id: "banana-gun", name: "Banana Gun", category: "telegram-bot", logoKey: "banana-gun", productUrl: "https://t.me/BananaGunSniper_bot", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "banana-gun", robinhoodKey: null },
  { id: "trojan", name: "Trojan", category: "telegram-bot", logoKey: "trojan", productUrl: "https://trojan.bot", benchUrl: "/benchmarks/trading-app-execution", evmKey: null, solanaKey: "trojan", robinhoodKey: null },
];
