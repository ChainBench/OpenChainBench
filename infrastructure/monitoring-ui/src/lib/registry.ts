export type HarnessRuntime =
  | {
      type: "railway";
      service: string;
      logsUrl: string;
      auth: "logs-token";
      extraRegions?: { region: string; service: string; logsUrl: string }[];
    }
  | { type: "ovh-systemd"; host: string; service: string; logsUrl: string; auth: "basic" }
  | { type: "none" };

export type BenchEntry = {
  slug: string;
  name: string;
  ocbYaml: string;
  harness: HarnessRuntime;
  /** Public GitHub URL of the harness source code (or YAML spec if no harness). */
  sourceUrl: string;
  promPrefix?: string;
};

export const OCB_REPO = { owner: "OpenChainBench", repo: "OpenChainBench" } as const;
export const MOBULA_REPO = { owner: "MobulaFi", repo: "mobula-monorepo" } as const;

export const PROD_URL = "https://openchainbench.com";
export const STAGING_URL = "https://staging-openchainbench.vercel.app";

// Public OCB harness tree. Prefer this for sourceUrl whenever an open-source
// harness exists so the dashboard never leaks paths inside the private monorepo.
const OCB_HARNESS_BASE = `https://github.com/${OCB_REPO.owner}/${OCB_REPO.repo}/tree/main/harnesses`;

// Private MobulaFi miniapps tree. Only use for benches that don't yet have a
// public OCB harness counterpart (currently network-fees + pm-data-freshness).
const MOBULA_BASE = `https://github.com/${MOBULA_REPO.owner}/${MOBULA_REPO.repo}/tree/dev/miniapps`;

export function benchPageUrl(branch: "main" | "dev", slug: string) {
  const base = branch === "main" ? PROD_URL : STAGING_URL;
  return `${base}/benchmarks/${slug}`;
}

export function diffUrl(slug: string) {
  return `https://github.com/${OCB_REPO.owner}/${OCB_REPO.repo}/compare/main...dev?expand=1&file=benchmarks/${slug}.yml`;
}

const RW = (service: string, host: string): HarnessRuntime => ({
  type: "railway",
  service,
  logsUrl: `https://${host}/logs`,
  auth: "logs-token",
});

const RW_MULTI = (
  primary: { service: string; host: string },
  extras: { region: string; service: string; host: string }[],
): HarnessRuntime => ({
  type: "railway",
  service: primary.service,
  logsUrl: `https://${primary.host}/logs`,
  auth: "logs-token",
  extraRegions: extras.map((e) => ({
    region: e.region,
    service: e.service,
    logsUrl: `https://${e.host}/logs`,
  })),
});

export const REGISTRY: BenchEntry[] = [
  {
    slug: "hyperliquid-frontends",
    name: "Hyperliquid frontends builder revenue",
    ocbYaml: "benchmarks/hyperliquid-frontends.yml",
    harness: {
      type: "ovh-systemd",
      host: "15.235.224.14",
      service: "hl-frontends-local",
      logsUrl: "http://15.235.224.14:8088/logs",
      auth: "basic",
    },
    sourceUrl: `${OCB_HARNESS_BASE}/hyperliquid-frontends`,
    promPrefix: "hl_frontend_",
  },
  {
    slug: "network-fees",
    name: "Current native transfer fee L1/L2",
    ocbYaml: "benchmarks/network-fees.yml",
    harness: RW("transaction-fee", "transaction-fee-production.up.railway.app"),
    sourceUrl: `${MOBULA_BASE}/transaction-fee`,
    promPrefix: "tx_fee_",
  },
  {
    slug: "solana-tx-landing",
    name: "Solana tx landing market share",
    ocbYaml: "benchmarks/solana-tx-landing.yml",
    harness: RW("tx-landing-solana-bench", "tx-landing-solana-bench-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/solana-tx-landing`,
    promPrefix: "solana_tx_landing_",
  },
  {
    slug: "solana-tx-landing-latency",
    name: "Solana tx landing latency (active probing)",
    ocbYaml: "benchmarks/solana-tx-landing-latency.yml",
    harness: RW("tx-landing-solana-bench", "tx-landing-solana-bench-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/solana-tx-landing`,
    promPrefix: "solana_landing_probe_",
  },
  {
    slug: "solana-dex-quote-latency",
    name: "Fastest Solana DEX quote API",
    ocbYaml: "benchmarks/solana-dex-quote-latency.yml",
    harness: RW_MULTI(
      { service: "solana-quote-us-east", host: "solana-quote-us-east-jd9g-cwjh-production.up.railway.app" },
      [
        { region: "eu-west", service: "solana-quote-eu-west", host: "solana-quote-eu-west-h888-za1j-production.up.railway.app" },
        { region: "sgp", service: "solana-quote-sgp", host: "solana-quote-sgp-i105-ytds-production.up.railway.app" },
      ],
    ),
    sourceUrl: `${OCB_HARNESS_BASE}/solana-quote-latency`,
    promPrefix: "solana_dex_quote_",
  },
  {
    slug: "evm-quote-latency",
    name: "Fastest EVM swap quote API",
    ocbYaml: "benchmarks/evm-quote-latency.yml",
    harness: { type: "none" },
    sourceUrl: `${OCB_HARNESS_BASE}/evm-swap-quoting`,
    promPrefix: "evm_swap_quote_",
  },
  {
    slug: "aggregator-head-lag",
    name: "Aggregator head lag",
    ocbYaml: "benchmarks/aggregator-head-lag.yml",
    harness: RW_MULTI(
      { service: "aggregator-east-usa", host: "aggregator-east-usa-production.up.railway.app" },
      [
        { region: "eu-west", service: "agg-eu-west", host: "agg-eu-west-production.up.railway.app" },
        { region: "sgp", service: "agg-sgp", host: "agg-sgp-production.up.railway.app" },
      ],
    ),
    sourceUrl: `${OCB_HARNESS_BASE}/aggregator-head-lag`,
    promPrefix: "agg_",
  },
  {
    slug: "bridge-fee",
    name: "Bridge fee",
    ocbYaml: "benchmarks/bridge-fee.yml",
    harness: { type: "none" },
    sourceUrl: `${OCB_HARNESS_BASE}/bridge-monitor`,
    promPrefix: "bridge_",
  },
  {
    slug: "bridge-quote-latency",
    name: "Bridge quote latency",
    ocbYaml: "benchmarks/bridge-quote-latency.yml",
    harness: { type: "none" },
    sourceUrl: `${OCB_HARNESS_BASE}/bridge-monitor`,
    promPrefix: "bridge_",
  },
  {
    slug: "bridge-revenue",
    name: "Cross-chain bridge implied protocol revenue",
    ocbYaml: "benchmarks/bridge-revenue.yml",
    harness: { type: "none" },
    sourceUrl: `${OCB_HARNESS_BASE}/bridge-monitor`,
    promPrefix: "bridge_",
  },
  {
    slug: "buyback-audit",
    name: "Buyback audit",
    ocbYaml: "benchmarks/buyback-audit.yml",
    harness: RW("buyback-audit", "buyback-audit-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/buyback-audit`,
  },
  {
    slug: "gas-estimation",
    name: "Gas estimation",
    ocbYaml: "benchmarks/gas-estimation.yml",
    harness: RW("gas-fee-estimation", "gas-fee-estimation-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/gas-estimation`,
  },
  {
    slug: "l1-finality",
    name: "L1 finality",
    ocbYaml: "benchmarks/l1-finality.yml",
    harness: RW("l1-finality", "l1-finality-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/l1-finality`,
    promPrefix: "l1_finality_",
  },
  {
    slug: "l2-block-time",
    name: "L2 block time",
    ocbYaml: "benchmarks/l2-block-time.yml",
    harness: RW("l2-block-time", "l2-block-time-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/l2-block-time`,
  },
  {
    slug: "metadata-coverage",
    name: "Metadata coverage",
    ocbYaml: "benchmarks/metadata-coverage.yml",
    harness: RW("metadata-coverage", "metadata-coverage-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/metadata-coverage`,
  },
  {
    slug: "network-coverage",
    name: "Network coverage",
    ocbYaml: "benchmarks/network-coverage.yml",
    harness: RW("network-coverage", "network-coverage-production-9eff.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/network-coverage`,
  },
  {
    slug: "oracle-deviation",
    name: "Oracle deviation",
    ocbYaml: "benchmarks/oracle-deviation.yml",
    harness: RW("oracle-deviation", "oracle-deviation-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/oracle-deviation`,
  },
  {
    slug: "perp-fees",
    name: "Perp fees",
    ocbYaml: "benchmarks/perp-fees.yml",
    harness: RW("perp-fee", "perp-fee-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/perp-fees`,
  },
  {
    slug: "rpc-capabilities",
    name: "RPC capabilities",
    ocbYaml: "benchmarks/rpc-capabilities.yml",
    harness: RW_MULTI(
      { service: "rpc-capabilities-us", host: "rpc-capabilities-us-production.up.railway.app" },
      [
        { region: "eu", service: "rpc-capabilities-eu", host: "rpc-capabilities-eu-production.up.railway.app" },
        { region: "sgp", service: "rpc-capabilities-sgp", host: "rpc-capabilities-sgp-production.up.railway.app" },
      ],
    ),
    sourceUrl: `${OCB_HARNESS_BASE}/rpc-capabilities`,
  },
  {
    slug: "stablecoin-peg",
    name: "Stablecoin peg",
    ocbYaml: "benchmarks/stablecoin-peg.yml",
    harness: RW("stablecoin-peg-bench", "stablecoin-peg-bench-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/stablecoin-peg`,
  },
  {
    slug: "stablecoin-peg-usdt-anchored",
    name: "Stablecoin peg (USDT anchored)",
    ocbYaml: "benchmarks/stablecoin-peg-usdt-anchored.yml",
    harness: RW("stablecoin-peg-bench", "stablecoin-peg-bench-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/stablecoin-peg`,
  },
  {
    slug: "validator-yield",
    name: "Validator yield",
    ocbYaml: "benchmarks/validator-yield.yml",
    harness: RW("validator-yield", "validator-yield-production.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/validator-yield`,
  },
  {
    slug: "wallet-labels-coverage",
    name: "Wallet labels coverage",
    ocbYaml: "benchmarks/wallet-labels-coverage.yml",
    harness: RW("wallet-labels", "mobula-monorepo-production-1f1b.up.railway.app"),
    sourceUrl: `${OCB_HARNESS_BASE}/wallet-labels`,
  },
  {
    slug: "pm-data-freshness",
    name: "Best prediction market data API by freshness",
    ocbYaml: "benchmarks/pm-data-freshness.yml",
    harness: RW("pm-freshness-bench", "pm-freshness-bench-production.up.railway.app"),
    sourceUrl: `${MOBULA_BASE}/pm-freshness-bench`,
    promPrefix: "pm_freshness_",
  },
];
