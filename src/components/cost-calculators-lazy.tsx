"use client";

import dynamic from "next/dynamic";

/**
 * The four pricing calculators, each in its own client chunk.
 *
 * The bench route is one shared page, and it imported every calculator
 * statically, so all ~300 bench pages (the 160 chain RPC pages included)
 * downloaded a 68 KB gzip chunk carrying the calculators and their committed
 * curves (SEO audit 2026-10-30). A dynamic import only splits when it is made
 * from a Client Component, hence this file. SSR stays on: the grid and the
 * calculator's default view must be in the HTML for readers and crawlers.
 */

export const RpcCostSlider = dynamic(() => import("./rpc-cost-slider").then((m) => m.RpcCostSlider));
export const RpcCostWinnersGrid = dynamic(() => import("./rpc-cost-slider").then((m) => m.RpcCostWinnersGrid));
export const WalletCostCalculator = dynamic(() => import("./wallet-cost-calculator").then((m) => m.WalletCostCalculator));
export const WalletCostGrid = dynamic(() => import("./wallet-cost-calculator").then((m) => m.WalletCostGrid));
export const ServerWalletCostCalculator = dynamic(() =>
  import("./server-wallet-cost-calculator").then((m) => m.ServerWalletCostCalculator),
);
export const ServerWalletCostGrid = dynamic(() =>
  import("./server-wallet-cost-calculator").then((m) => m.ServerWalletCostGrid),
);
export const PaymasterCostCalculator = dynamic(() =>
  import("./paymaster-cost-calculator").then((m) => m.PaymasterCostCalculator),
);
export const PaymasterCostGrid = dynamic(() => import("./paymaster-cost-calculator").then((m) => m.PaymasterCostGrid));
