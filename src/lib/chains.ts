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
import { getBenchmarksSafe } from "@/data/benchmarks";
import type { Benchmark } from "@/types/benchmark";
import {
  CHAIN_SLUG_ALIASES,
  canonicalChainSlug,
} from "@/lib/chain-aliases";

export { CHAIN_SLUG_ALIASES, canonicalChainSlug };

export type ChainCategory = "L1" | "L2" | "L3";

export type ChainEntry = {
  slug: string;
  label: string;
  category: ChainCategory;
  description: string;
  /**
   * Optional native token symbol. When set, the /chains/[slug] page surfaces
   * the Native price + mcap KPI cards via the Mobula `/market/data?symbol=…`
   * gauge series sourced by the chain-kpis harness. Empty / undefined =
   * the page won't render those cards. 100% coverage today across the
   * 21 chains in this registry; declared explicitly so a new chain that
   * forgets to set it just hides the cards rather than rendering a wrong
   * symbol. Long-tail chains added with the 055-066 RPC cluster
   * (2026-07-03) set their best-known symbol; cards stay hidden until
   * the chain-kpis harness sources the series.
   */
  nativeSymbol?: string;
};

export const CHAINS: ChainEntry[] = [
  {
    slug: "ethereum",
    label: "Ethereum",
    category: "L1",
    nativeSymbol: "ETH",
    description:
      "EVM Layer 1. EIP-1559 fee market, Casper FFG finalization across 32-slot epochs (12.8-minute target).",
  },
  {
    slug: "solana",
    label: "Solana",
    category: "L1",
    nativeSymbol: "SOL",
    description:
      "Proof of History timestamps + Tower BFT consensus, 400 ms slot, parallel transaction execution.",
  },
  {
    slug: "bnb",
    label: "BNB Chain",
    category: "L1",
    nativeSymbol: "BNB",
    description:
      "Parlia PoSA consensus with 21 active validators, 3 s block, EVM compatible, BEP-126 fast finality.",
  },
  {
    slug: "avalanche",
    label: "Avalanche",
    category: "L1",
    nativeSymbol: "AVAX",
    description:
      "Snowman consensus, sub-second finality, EVM C-Chain with dynamic fee target adjusting every 10 s.",
  },
  {
    slug: "sui",
    label: "Sui",
    category: "L1",
    nativeSymbol: "SUI",
    description:
      "Mysticeti DAG-BFT consensus, reference gas price model, deterministic sub-second finality.",
  },
  {
    slug: "gram",
    label: "Gram",
    category: "L1",
    nativeSymbol: "GRAM",
    description:
      "Gram (formerly TON / Toncoin). BAG consensus, masterchain + workchains, deterministic finality under one second on the masterchain commit. Native token renamed Toncoin → Gram in June 2026.",
  },
  {
    slug: "stellar",
    label: "Stellar",
    category: "L1",
    nativeSymbol: "XLM",
    description:
      "Stellar Consensus Protocol (SCP), roughly 5 s ledger close, deterministic finality on every close.",
  },
  {
    slug: "tron",
    label: "TRON",
    category: "L1",
    nativeSymbol: "TRX",
    description:
      "20-block solidity confirmation, bandwidth + energy resource model, no priority fee market for native transfers.",
  },
  {
    slug: "cardano",
    label: "Cardano",
    category: "L1",
    nativeSymbol: "ADA",
    description:
      "Ouroboros Proof of Stake, deterministic protocol fees set by governance, EUTXO accounting model.",
  },
  {
    slug: "cosmos-hub",
    label: "Cosmos Hub",
    category: "L1",
    nativeSymbol: "ATOM",
    description:
      "Cosmos Hub (ATOM). Tendermint / CometBFT consensus, ~6 s block, instant finality, IBC hub for the wider Cosmos ecosystem.",
  },
  {
    slug: "litecoin",
    label: "Litecoin",
    category: "L1",
    nativeSymbol: "LTC",
    description:
      "Bitcoin fork, 2.5-minute target block, SegWit support, UTXO fee market priced in litoshi per virtual byte.",
  },
  {
    slug: "monero",
    label: "Monero",
    category: "L1",
    nativeSymbol: "XMR",
    description:
      "RingCT privacy transactions, dynamic block-size penalty, 2-minute target block, three-tier fee estimate RPC.",
  },
  {
    slug: "polygon",
    label: "Polygon PoS",
    category: "L1",
    nativeSymbol: "POL",
    description:
      "Bor block 2 s target, EIP-1559 fee market, validator-rotated tip auctions, MATIC-denominated priority fees.",
  },
  {
    slug: "arbitrum",
    label: "Arbitrum One",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Optimistic rollup on the Nitro stack with a single Offchain Labs sequencer, 250 ms block target, batches posted to Ethereum.",
  },
  {
    slug: "optimism",
    label: "Optimism",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack reference rollup, 2 s sequencer cadence, EIP-4844 blob calldata settlement on Ethereum.",
  },
  {
    slug: "robinhood",
    label: "Robinhood Chain",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Robinhood's Arbitrum Orbit rollup for tokenized stocks, ~100 ms blocks, ETH gas, Ethereum blob settlement, sequencer operated by Robinhood with 10% of chain fees shared to ArbitrumDAO.",
  },
  {
    slug: "base",
    label: "Base",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Coinbase OP Stack rollup, 2 s sequencer, blob calldata settlement, Flashblocks pre-confirmation path in test.",
  },
  {
    slug: "zksync",
    label: "zkSync Era",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Matter Labs zk-rollup with SNARK prover batching, custom bundled gas model covering execution, pubdata and prover cost.",
  },
  {
    slug: "linea",
    label: "Linea",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Consensys zkEVM with PLONK-family proofs, 2 s nominal slot, sequencer-set base fee tracking prover batch economics.",
  },
  {
    slug: "scroll",
    label: "Scroll",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Bytecode-equivalent zkEVM with Halo2 prover, 3 s nominal block target, centralized sequencer batching for prover.",
  },
  {
    slug: "blast",
    label: "Blast",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack fork with native ETH yield auto-rebasing against L1 staking + T-bill yields, 2 s sequencer.",
  },
  {
    slug: "mantle",
    label: "Mantle",
    category: "L2",
    nativeSymbol: "MNT",
    description:
      "OP Stack fork using EigenDA for data availability instead of Ethereum blob calldata, 2 s sequencer.",
  },
  {
    slug: "taiko",
    label: "Taiko",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Based rollup. Ethereum L1 validators sequence Taiko blocks directly, inheriting L1 liveness and censorship resistance.",
  },
  // ─── Performance chains added 2026-07-08 (benches 071-072) ───
  {
    slug: "monad",
    label: "Monad",
    category: "L1",
    nativeSymbol: "MON",
    description:
      "Parallel-execution EVM Layer 1 (mainnet Nov 2025). 400 ms blocks, MonadBFT finality in about 800 ms, full EVM bytecode compatibility.",
  },
  {
    slug: "megaeth",
    label: "MegaETH",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Real-time Ethereum L2 (mainnet Feb 2026). 10 ms mini-blocks batched into 1 s EVM blocks, data availability on EigenDA, ZK fraud proofs via Kailua.",
  },
  // ─── Long-tail chains added with the 055-066 RPC cluster (2026-07-03) ───
  {
    slug: "sonic",
    label: "Sonic",
    category: "L1",
    nativeSymbol: "S",
    description:
      "EVM Layer 1 by Sonic Labs (Fantom lineage), sub-second finality, ~0.5 s blocks, fee-monetization revenue share for apps.",
  },
  {
    slug: "gnosis",
    label: "Gnosis",
    category: "L1",
    nativeSymbol: "GNO",
    description:
      "EVM Layer 1 with xDAI as the gas token, 5 s blocks, Gnosis Beacon Chain consensus mirroring Ethereum's PoS design.",
  },
  {
    slug: "celo",
    label: "Celo",
    category: "L2",
    nativeSymbol: "CELO",
    description:
      "Former L1 migrated to an Ethereum L2 (OP Stack) in 2025, 1 s blocks, gas payable in CELO and whitelisted stablecoins.",
  },
  {
    slug: "moonbeam",
    label: "Moonbeam",
    category: "L1",
    nativeSymbol: "GLMR",
    description:
      "Polkadot EVM parachain, ~6 s blocks under async backing, GLMR gas, unified Substrate + EVM account model.",
  },
  {
    slug: "unichain",
    label: "Unichain",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Uniswap Labs OP Stack rollup, 1 s blocks with 250 ms Flashblocks pre-confirmations, DeFi-focused sequencing.",
  },
  {
    slug: "berachain",
    label: "Berachain",
    category: "L1",
    nativeSymbol: "BERA",
    description:
      "EVM Layer 1 on the BeaconKit stack with proof-of-liquidity consensus, ~2 s blocks, BERA gas + BGT governance split.",
  },
  {
    slug: "cronos",
    label: "Cronos",
    category: "L1",
    nativeSymbol: "CRO",
    description:
      "Crypto.com EVM chain built on Cosmos SDK + Ethermint, ~1 s blocks, IBC connectivity, CRO-denominated gas.",
  },
  {
    slug: "fraxtal",
    label: "Fraxtal",
    category: "L2",
    nativeSymbol: "frxETH", // gas token; FRAX here mislabeled the frxETH price the harness measures
    description:
      "Frax Finance OP Stack rollup, 2 s sequencer cadence, frxETH-denominated gas with FXTL incentive points.",
  },
  {
    slug: "soneium",
    label: "Soneium",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Sony Block Solutions OP Stack rollup in the Optimism Superchain, 2 s blocks, consumer and entertainment focus.",
  },
  {
    slug: "polkadot",
    label: "Polkadot",
    category: "L1",
    nativeSymbol: "DOT",
    description:
      "Substrate-based relay chain coordinating a parachain ecosystem via shared security. GRANDPA finality with BABE block production, ~6 s block time.",
  },
  {
    slug: "osmosis",
    label: "Osmosis",
    category: "L1",
    nativeSymbol: "OSMO",
    description:
      "Cosmos SDK appchain and the largest IBC-connected DEX. CometBFT (Tendermint) consensus with deterministic finality per block, ~6 s block time. TokenFactory + IBC v3 native, x/superfluid staking on LP shares.",
  },
  {
    slug: "hyperliquid",
    label: "Hyperliquid",
    category: "L1",
    nativeSymbol: "HYPE",
    description:
      "HyperEVM (chain id 999). Hyperliquid Labs's EVM execution layer bolted onto the HyperCore perps engine, ~2 s blocks, HyperBFT consensus, native HYPE gas. First on-chain perp DEX to reach $1B+ daily volume.",
  },
  {
    slug: "cosmos-hub",
    label: "Cosmos Hub",
    category: "L1",
    nativeSymbol: "ATOM",
    description:
      "The original Cosmos SDK chain and IBC hub, ATOM staking token, CometBFT (Tendermint) consensus with deterministic per-block finality, ~6 s block time. Interchain Security (v2) rents validator security to consumer chains.",
  },
  {
    slug: "injective",
    label: "Injective",
    category: "L1",
    nativeSymbol: "INJ",
    description:
      "Cosmos SDK L1 tuned for DeFi and orderbook DEXs, native CosmWasm + EVM execution modules, ~0.65 s block time, INJ deflationary burn on all app-layer fees.",
  },
  {
    slug: "neutron",
    label: "Neutron",
    category: "L1",
    nativeSymbol: "NTRN",
    description:
      "Cosmos SDK smart-contract chain running CosmWasm, secured by Cosmos Hub validators via Interchain Security. ~2 s block time, IBC-native asset flows, home of Astroport and other Cosmos DeFi apps.",
  },
  {
    slug: "world-chain",
    label: "World Chain",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack rollup (chain 480) operated by Tools for Humanity, prioritised block space for World ID-verified humans, WLD as an ecosystem token but ETH gas, 2 s sequencer cadence, blob calldata settlement on Ethereum.",
  },
  {
    slug: "kaia",
    label: "Kaia",
    category: "L1",
    nativeSymbol: "KAIA",
    description:
      "EVM L1 formed by the Klaytn + Finschia merger in Aug 2024. Istanbul BFT consensus with a fixed validator set, 1 s block target, KAIA gas token, dominant footprint in Korea + Japan through LINE / Kakao integrations.",
  },
  {
    slug: "ink",
    label: "Ink",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack rollup (chain 57073) launched by Kraken in late 2024, 1 s sequencer cadence, ETH gas, blob calldata settlement on Ethereum. DeFi-first positioning with a native ecosystem incentive program.",
  },
  {
    slug: "opbnb",
    label: "opBNB",
    category: "L2",
    nativeSymbol: "BNB",
    description:
      "OP Stack rollup (chain 204) operated by the BNB Chain team, BNB gas token, ~1 s sequencer cadence, settlement onto BNB Chain (not Ethereum). Positioned as the low-cost execution layer for the BNB ecosystem.",
  },
  {
    slug: "sei",
    label: "Sei",
    category: "L1",
    nativeSymbol: "SEI",
    description:
      "Cosmos SDK L1 (chain 1329) with a parallel-execution EVM layer bolted onto Tendermint consensus, launched by Sei Labs. SEI gas token for both sides, sub-second finality, positioned as a high-throughput trading chain.",
  },
  {
    slug: "mode",
    label: "Mode",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack rollup (chain 34443) in the Base / Superchain ecosystem, ETH gas, DeFi + AI-agent positioning. 2 s sequencer cadence, standard OP Stack blob settlement on Ethereum.",
  },
  {
    slug: "ronin",
    label: "Ronin",
    category: "L1",
    nativeSymbol: "RON",
    description:
      "EVM L1 (chain 2020) operated by Sky Mavis, purpose-built for Web3 gaming and home of Axie Infinity, Pixels and a broader gaming stack. RON gas, delegated proof-of-stake, 3 s block cadence.",
  },
  {
    slug: "immutable",
    label: "Immutable zkEVM",
    category: "L2",
    nativeSymbol: "IMX",
    description:
      "Polygon CDK zkEVM L2 (chain 13371) operated by Immutable, dedicated Web3 gaming stack, IMX gas token, 2 s block cadence, settlement onto Ethereum via zk-proofs.",
  },
  {
    slug: "kava",
    label: "Kava",
    category: "L1",
    nativeSymbol: "KAVA",
    description:
      "Cosmos SDK Layer 1 (chain 2222) with a native EVM execution layer, ~5 s block time under Tendermint BFT consensus, KAVA gas token on the EVM side, and IBC connectivity to the wider Cosmos ecosystem.",
  },
  {
    slug: "zora",
    label: "Zora",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack rollup (chain 7777777) operated by Zora Network, optimised for NFT minting and creative media on-chain, ~2 s sequencer cadence, ETH gas, blob calldata settlement on Ethereum.",
  },
  {
    slug: "abstract",
    label: "Abstract",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "ZK Stack validium L2 (chain 2741) built by the Abstract Foundation, optimised for consumer applications and NFTs, ETH gas token, ~2 s block cadence, ZK proof settlement onto Ethereum.",
  },
  {
    slug: "apechain",
    label: "ApeChain",
    category: "L3",
    nativeSymbol: "APE",
    description:
      "Arbitrum Orbit L3 (chain 33139) operated by Yuga Labs / ApeDAO, dedicated to the APE ecosystem, APE gas token, ~250 ms block cadence, settlement onto Arbitrum One.",
  },
  {
    slug: "lisk",
    label: "Lisk",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack L2 (chain 1135) operated by Onchain Foundation (formerly Lisk Foundation), focused on emerging-market Web3 adoption, ETH gas token, ~2 s block cadence, blob calldata settlement on Ethereum.",
  },
  {
    slug: "swellchain",
    label: "Swellchain",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack L2 (chain 1923) operated by Swell Network, the restaking-native rollup built on EigenLayer, ETH gas token, ~2 s block cadence, blob calldata settlement on Ethereum.",
  },
  {
    slug: "cyber",
    label: "Cyber",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack L2 (chain 7560) operated by Cyber, a social-layer chain for SocialFi and Web3 social graphs, ETH gas token, ~2 s block cadence, blob calldata settlement on Ethereum.",
  },
  {
    slug: "rootstock",
    label: "Rootstock",
    category: "L2",
    nativeSymbol: "RBTC",
    description:
      "Bitcoin sidechain (chain 30) operated by the Rootstock Foundation, merge-mined with Bitcoin for 51% attack resistance, EVM-compatible smart contracts with BTC as native gas (RBTC), ~30 s block time.",
  },
  {
    slug: "metis",
    label: "Metis",
    category: "L2",
    nativeSymbol: "METIS",
    description:
      "Optimistic rollup (chain 1088) with a decentralized sequencer network, METIS as both gas token and sequencer staking asset, ~2 s block cadence, settlement on Ethereum.",
  },
  {
    slug: "manta",
    label: "Manta Pacific",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OP Stack EVM L2 (chain 169) built on Celestia for data availability, optimised for zero-knowledge applications and DeFi, ETH gas token, ~2 s block cadence, settlement on Ethereum.",
  },
  {
    slug: "story",
    label: "Story",
    category: "L1",
    nativeSymbol: "IP",
    description:
      "Purpose-built L1 (chain 1514) for on-chain intellectual property with EVM execution layer and CometBFT consensus, IP asset primitives (PIL licensing, royalty modules), IP gas token.",
  },
  {
    slug: "morph",
    label: "Morph",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "ZK Rollup L2 (chain 2818) combining optimistic execution with ZK proof settlement on Ethereum, ETH gas token, ~2 s block cadence, Decentralized Sequencer Network for censorship resistance.",
  },
  {
    slug: "moonriver",
    label: "Moonriver",
    category: "L1",
    nativeSymbol: "MOVR",
    description:
      "Kusama parachain (chain 1285) operated by the Moonbeam Foundation, full EVM compatibility with Ethereum tooling, MOVR gas token, ~12 s block time under Nominated Proof of Stake, canary network for Moonbeam.",
  },
  {
    slug: "hemi",
    label: "Hemi",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Bitcoin+Ethereum hybrid L2 (chain 43111) built on OP Stack with dual-VM architecture running both EVM and Bitcoin script, ETH gas token, ~2 s block cadence, designed to unify BTC and ETH liquidity.",
  },
  {
    slug: "bob",
    label: "BOB",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Build on Bitcoin — OP Stack hybrid L2 (chain 60808) bridging Bitcoin and Ethereum, enabling Bitcoin DeFi with EVM smart contracts and native BTC collateral, ETH gas token, ~2 s block cadence.",
  },
  {
    slug: "polygon-zkevm",
    label: "Polygon zkEVM",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "Polygon's ZK rollup L2 (chain 1101) settling on Ethereum, using ZK proofs for validity, ETH gas token, ~2 s block cadence, EVM-equivalent smart contract execution with full Ethereum tooling support.",
  },
  {
    slug: "arbitrum-nova",
    label: "Arbitrum Nova",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "AnyTrust chain (chain 42170) on the Nitro stack, optimised for high-throughput gaming and social apps with ultra-low fees, ETH gas token, ~1 s block cadence, minimal on-chain data via a Data Availability Committee.",
  },
  {
    slug: "xlayer",
    label: "X Layer",
    category: "L2",
    nativeSymbol: "ETH",
    description:
      "OKX ZK-powered L2 (chain 196) built with Polygon CDK and Aggregation Layer, ETH gas token, ~2 s block cadence, Ethereum settlement, launched April 2024.",
  },
  {
    slug: "flare",
    label: "Flare",
    category: "L1",
    nativeSymbol: "FLR",
    description:
      "EVM-compatible L1 (chain 14) specialising in cross-chain data acquisition with native enshrined oracles (FTSOv2 price feeds, FDC cross-chain attestation), FLR gas token, ~1.8 s block cadence.",
  },
  {
    slug: "core",
    label: "Core Chain",
    category: "L1",
    nativeSymbol: "CORE",
    description:
      "Bitcoin-aligned EVM-compatible L1 (chain 1116) using Satoshi Plus consensus combining Bitcoin PoW mining with delegated PoS, CORE gas token, ~3 s block cadence, Self-Custodial Bitcoin Staking.",
  },
  {
    slug: "fuse",
    label: "Fuse Network",
    category: "L1",
    nativeSymbol: "FUSE",
    description:
      "Community-owned EVM-compatible blockchain (chain 122) built around business payments and consumer DeFi, FUSE gas token, ~5 s block cadence with AuRa-based PoA consensus.",
  },
];

export const CHAIN_BY_SLUG = new Map(CHAINS.map((c) => [c.slug, c]));

/** Display label for a slug, resolving aliases against the chain
 *  registry. Returns null when neither the canonical nor the raw slug
 *  is registered, so callers can fall back to whatever local data they
 *  have (e.g. the bench result's own name field). Lives here (not in
 *  chain-aliases.ts) because it depends on the CHAIN_BY_SLUG registry
 *  which IS in this module. Callers inside the spec/data layer that
 *  would create a circular import should use `canonicalChainSlug`
 *  from `@/lib/chain-aliases` directly. */
export function chainLabelForSlug(slug: string): string | null {
  const canon = canonicalChainSlug(slug);
  return CHAIN_BY_SLUG.get(canon)?.label ?? null;
}

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
  const benches = await getBenchmarksSafe();
  // Build the set of slugs that should resolve as this chain: the input
  // itself plus any legacy slug that aliases TO it. This lets the new
  // canonical /chains/<gram> URL still find benches whose results or
  // dimensions still carry the legacy "ton" slug while the YAMLs +
  // materialize snapshots + harness labels rotate over.
  const canon = canonicalChainSlug(chainSlug);
  const accept = new Set<string>([canon]);
  for (const [legacy, target] of Object.entries(CHAIN_SLUG_ALIASES)) {
    if (target === canon) accept.add(legacy);
  }
  // Per-chain benchmark slug conventions. A bench with slug matching one
  // of these patterns for the canonical chain is treated as belonging to
  // it even when it does not carry the chain in results[].slug or
  // dimensions.chain[] (which is the case for chain-scoped RPC benches:
  // `sonic-rpc`, `unichain-rpc`, etc. list providers as results, not the
  // chain itself). Without this, 9 long-tail chains (sonic, gnosis, celo,
  // moonbeam, unichain, soneium, berachain, fraxtal, cronos) drop out of
  // the /chains/<slug> hub and had to be filtered from the sitemap by
  // hand (see prior fix #910). New per-chain bench conventions land here.
  const conventionSuffixes = ["-rpc"];
  const acceptedSlugPatterns = new Set<string>();
  for (const slug of accept) {
    for (const suffix of conventionSuffixes) {
      acceptedSlugPatterns.add(`${slug}${suffix}`);
    }
  }

  return benches.filter((b) => {
    if (b.results.some((r) => accept.has(r.slug.toLowerCase()))) return true;
    if (b.dimensions?.chain?.some((c) => accept.has(c.value.toLowerCase())))
      return true;
    if (acceptedSlugPatterns.has(b.slug.toLowerCase())) return true;
    return false;
  });
});
