/**
 * Chain registry for the `/chains/[slug]` hub. Each entry maps a chain
 * slug used across the benchmark YAMLs (`b.results[].slug` on row shape
 * benches, `b.dimensions.chain[].value` on dimension shape benches) to
 * a display label, a category, and a short editorial description.
 *
 * The hub auto detects which benches measure a given chain via
 * `getBenchmarksForChain`, so adding a new chain here is the only step
 * needed to publish a `/chains/<slug>` page. Adding a chain that never
 * appears in any bench would surface an empty page, so the chain
 * registry stays in sync with the benchmark catalog by design.
 */

import { cache } from "react";
import { getBenchmarks } from "@/data/benchmarks";
import type { Benchmark } from "@/types/benchmark";

export type ChainCategory = "L1" | "L2";

export type ChainEntry = {
  slug: string;
  label: string;
  category: ChainCategory;
  description: string;
};

export const CHAINS: ChainEntry[] = [
  {
    slug: "ethereum",
    label: "Ethereum",
    category: "L1",
    description:
      "EVM Layer 1. EIP-1559 fee market, Casper FFG finalization across 32-slot epochs (12.8-minute target).",
  },
  {
    slug: "solana",
    label: "Solana",
    category: "L1",
    description:
      "Proof of History timestamps + Tower BFT consensus, 400 ms slot, parallel transaction execution.",
  },
  {
    slug: "bnb",
    label: "BNB Chain",
    category: "L1",
    description:
      "Parlia PoSA consensus with 21 active validators, 3 s block, EVM compatible, BEP-126 fast finality.",
  },
  {
    slug: "avalanche",
    label: "Avalanche",
    category: "L1",
    description:
      "Snowman consensus, sub-second finality, EVM C-Chain with dynamic fee target adjusting every 10 s.",
  },
  {
    slug: "sui",
    label: "Sui",
    category: "L1",
    description:
      "Mysticeti DAG-BFT consensus, reference gas price model, deterministic sub-second finality.",
  },
  {
    slug: "ton",
    label: "TON",
    category: "L1",
    description:
      "BAG consensus, masterchain + workchains, deterministic finality under one second on the masterchain commit.",
  },
  {
    slug: "stellar",
    label: "Stellar",
    category: "L1",
    description:
      "Stellar Consensus Protocol (SCP), roughly 5 s ledger close, deterministic finality on every close.",
  },
  {
    slug: "tron",
    label: "TRON",
    category: "L1",
    description:
      "20-block solidity confirmation, bandwidth + energy resource model, no priority fee market for native transfers.",
  },
  {
    slug: "cardano",
    label: "Cardano",
    category: "L1",
    description:
      "Ouroboros Proof of Stake, deterministic protocol fees set by governance, EUTXO accounting model.",
  },
  {
    slug: "litecoin",
    label: "Litecoin",
    category: "L1",
    description:
      "Bitcoin fork, 2.5-minute target block, SegWit support, UTXO fee market priced in litoshi per virtual byte.",
  },
  {
    slug: "monero",
    label: "Monero",
    category: "L1",
    description:
      "RingCT privacy transactions, dynamic block-size penalty, 2-minute target block, three-tier fee estimate RPC.",
  },
  {
    slug: "polygon",
    label: "Polygon PoS",
    category: "L1",
    description:
      "Bor block 2 s target, EIP-1559 fee market, validator-rotated tip auctions, MATIC-denominated priority fees.",
  },
  {
    slug: "arbitrum",
    label: "Arbitrum One",
    category: "L2",
    description:
      "Optimistic rollup on the Nitro stack with a single Offchain Labs sequencer, 250 ms block target, batches posted to Ethereum.",
  },
  {
    slug: "optimism",
    label: "Optimism",
    category: "L2",
    description:
      "OP Stack reference rollup, 2 s sequencer cadence, EIP-4844 blob calldata settlement on Ethereum.",
  },
  {
    slug: "base",
    label: "Base",
    category: "L2",
    description:
      "Coinbase OP Stack rollup, 2 s sequencer, blob calldata settlement, Flashblocks pre-confirmation path in test.",
  },
  {
    slug: "zksync",
    label: "zkSync Era",
    category: "L2",
    description:
      "Matter Labs zk-rollup with SNARK prover batching, custom bundled gas model covering execution, pubdata and prover cost.",
  },
  {
    slug: "linea",
    label: "Linea",
    category: "L2",
    description:
      "Consensys zkEVM with PLONK-family proofs, 2 s nominal slot, sequencer-set base fee tracking prover batch economics.",
  },
  {
    slug: "scroll",
    label: "Scroll",
    category: "L2",
    description:
      "Bytecode-equivalent zkEVM with Halo2 prover, 3 s nominal block target, centralized sequencer batching for prover.",
  },
  {
    slug: "blast",
    label: "Blast",
    category: "L2",
    description:
      "OP Stack fork with native ETH yield auto-rebasing against L1 staking + T-bill yields, 2 s sequencer.",
  },
  {
    slug: "mantle",
    label: "Mantle",
    category: "L2",
    description:
      "OP Stack fork using EigenDA for data availability instead of Ethereum blob calldata, 2 s sequencer.",
  },
  {
    slug: "taiko",
    label: "Taiko",
    category: "L2",
    description:
      "Based rollup. Ethereum L1 validators sequence Taiko blocks directly, inheriting L1 liveness and censorship resistance.",
  },
];

export const CHAIN_BY_SLUG = new Map(CHAINS.map((c) => [c.slug, c]));

/**
 * Returns the list of benchmarks that surface this chain in some way:
 *
 *   1. Row shape benches (l1-finality, l2-block-time, network-fees):
 *      the chain is a leaderboard row, matched on `results[].slug`.
 *   2. Dimension shape benches (rpc-capabilities, evm-quote-latency,
 *      aggregator-head-lag, gas-estimation, metadata-coverage):
 *      the chain is a filter dimension, matched on
 *      `dimensions.chain[].value`.
 *
 * Same slug grammar across both shapes (lowercase, kebab-case), so a
 * chain registered here lights up wherever its slug appears in any
 * spec. Adding a new bench that uses a known chain slug surfaces it
 * automatically on the matching `/chains/<slug>` page.
 */
export const getBenchmarksForChain = cache(async function getBenchmarksForChain(
  chainSlug: string,
): Promise<Benchmark[]> {
  const benches = await getBenchmarks();
  return benches.filter((b) => {
    if (b.results.some((r) => r.slug === chainSlug)) return true;
    if (b.dimensions?.chain?.some((c) => c.value === chainSlug)) return true;
    return false;
  });
});
