package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

const (
	ethereumChain         = "ethereum"
	ultrasoundSourceTag   = "ultrasound_money"
	coingeckoEthSourceTag = "coingecko_eth"
)

// Ethereum source choice (evaluated live 2026-07-08, all with
// User-Agent "OpenChainBench-harness/1.0"):
//
//	CHOSEN: ultrasound.money `/api/v2/fees/effective-balance-sum`.
//	Free, keyless, one tiny JSON object ({slot, sum, timestamp}, sum
//	in gwei) served from ultrasound's own beacon node. We plug the
//	live total effective balance into the consensus-spec reward
//	formula (see below) to get the network-average nominal
//	consensus-layer APR for a 32 ETH solo validator. This matches
//	the bench definition style: Hyperliquid publishes a nominal
//	staking-only APR (`predictedApr`), and Solana publishes a
//	nominal trailing APR. The Ethereum number is staking
//	(consensus) only: attestation + proposer + sync-committee
//	rewards in expectation, EXCLUDING execution-layer tips and MEV.
//
//	REJECTED: beaconcha.in `/api/v1/ethstore/latest` (would have
//	given a measured day-APR incl. execution rewards) — now returns
//	"Unauthorized: a valid API key is required" even at 1 req/day;
//	the free keyless tier was removed. REJECTED: Lido
//	`eth-api.lido.fi/v1/protocol/steth/apr/sma` — free and keyless
//	but it is a liquid-staking PRODUCT APR (net of Lido's 10% fee,
//	includes EL rewards), not a validator yield; wrong definition
//	for this bench. REJECTED: DefiLlama `yields.llama.fi/pools` —
//	same objection, LST product APYs. REJECTED: full beacon-node
//	validator scrape (`/eth/v1/beacon/states/head/validators`) —
//	multi-hundred-MB response over ~1M validators, not a 5-minute
//	HTTP poll; that path stays "v2" as the bench originally noted.
//
// Consensus-spec APR formula (Altair reward accounting):
//
//	base_reward_per_increment = EFFECTIVE_BALANCE_INCREMENT(1e9 gwei)
//	                            × BASE_REWARD_FACTOR(64)
//	                            / sqrt(total_active_balance_gwei)
//
// A perfectly-performing validator earns, in expectation across
// attestation (54/64), proposer (8/64) and sync-committee (2/64)
// weights, exactly one full base reward per increment per epoch.
// With 82181.25 epochs/year (384 s epochs), the nominal APR is:
//
//	apr = BASE_REWARD_FACTOR × EPOCHS_PER_YEAR / sqrt(total_gwei)
//
// This is the ideal (100% participation) network-average number.
// Realized network participation runs ~99.5%, so the published
// figure overstates the realized average by well under 2 bps. We do
// NOT fold participation in: measuring it honestly needs per-epoch
// attestation data (beacon-node ingestion, the v2 path). uptime_pct
// is published as 100 accordingly and the YAML prose says so.
const (
	ethBaseRewardFactor = 64.0
	ethEpochsPerYear    = 365.25 * 24 * 3600 / 384 // 82181.25, 384 s per epoch
)

// ultrasoundEffectiveBalance mirrors
// https://ultrasound.money/api/v2/fees/effective-balance-sum
// Verified shape (2026-07-08):
//
//	{"slot":14724497,"sum":40389900000000000,"timestamp":"2026-07-08T13:39:47Z"}
//
// `sum` is total beacon-chain effective balance in gwei.
type ultrasoundEffectiveBalance struct {
	Slot      int64   `json:"slot"`
	Sum       float64 `json:"sum"` // gwei
	Timestamp string  `json:"timestamp"`
}

func fetchEthEffectiveBalanceGwei(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ultrasoundURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-harness/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("ultrasound http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var out ultrasoundEffectiveBalance
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, fmt.Errorf("ultrasound parse: %w", err)
	}
	// Sanity bounds: anything under 1M or over 200M ETH staked is a
	// data-quality failure, not a real reading. No publish on failure.
	const gweiPerEth = 1e9
	stakedEth := out.Sum / gweiPerEth
	if stakedEth < 1e6 || stakedEth > 2e8 {
		return 0, fmt.Errorf("ultrasound implausible effective balance: %.0f ETH", stakedEth)
	}
	return out.Sum, nil
}

// fetchEthereumPrice hits CoinGecko's free simple/price endpoint,
// same pattern (and same free-tier budget math) as fetchSolanaPrice:
// 1 call per 5-minute cycle against a ~30 req/min ceiling.
func fetchEthereumPrice(ctx context.Context, client *http.Client) (float64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, coingeckoEthURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench-harness/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("coingecko http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var payload map[string]map[string]float64
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("coingecko parse: %w", err)
	}
	v, ok := payload["ethereum"]
	if !ok {
		return 0, fmt.Errorf("coingecko missing ethereum key")
	}
	price := v["usd"]
	if price <= 0 {
		return 0, fmt.Errorf("coingecko invalid price %f", price)
	}
	return price, nil
}

// scrapeEthereum publishes ONE synthetic series per gauge:
// validator="beacon-network", the network-average solo validator.
// Ethereum has ~1M active validator indices; per-validator gauges are
// not representable on the OCB Prom cardinality budget and, unlike
// Solana/Hyperliquid, no free keyless API exposes per-validator APR.
// Because consensus rewards are stake-weighted uniformly (every
// 32 ETH increment earns the same base reward in expectation), the
// network average IS the solo-validator nominal APR, so a single
// series loses no ranking information for this bench.
//
// Gauge semantics for the synthetic row:
//
//	gross = net    consensus-spec nominal APR (uptime published as
//	               100; realized participation ~99.5%, see above)
//	mev_share = 0  execution-layer tips/MEV deliberately excluded
//	commission = 0 a solo validator pays no commission
//	stake_usd      TOTAL network effective balance in USD (this row
//	               represents the whole network, not one operator)
//	jailed = 0
//	total_validators = 1 (series exposed by the harness, per the
//	               metric's documented definition; NOT the ~1M
//	               active validator count)
func scrapeEthereum(ctx context.Context, client *http.Client) {
	totalGwei, err := fetchEthEffectiveBalanceGwei(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(ethereumChain, ultrasoundSourceTag).Inc()
		fmt.Printf("[ethereum] ultrasound err: %v\n", err)
		return
	}

	ethPrice, err := fetchEthereumPrice(ctx, client)
	if err != nil {
		scrapeErrorsTotal.WithLabelValues(ethereumChain, coingeckoEthSourceTag).Inc()
		fmt.Printf("[ethereum] coingecko err (stake_usd will be 0): %v\n", err)
		ethPrice = 0
	}

	// apr = BASE_REWARD_FACTOR × EPOCHS_PER_YEAR / sqrt(total_gwei),
	// as a fraction (0.026 = 2.6%) → bps via pctToBps.
	apr := ethBaseRewardFactor * ethEpochsPerYear / math.Sqrt(totalGwei)
	grossBps := pctToBps(apr)

	const (
		id   = "beacon-network"
		name = "Ethereum solo validator (network avg)"
	)

	uptimePct := 100.0
	netBps := grossBps * (uptimePct / 100)
	stakedEth := totalGwei / 1e9
	stakeUSD := stakedEth * ethPrice

	validatorNetYieldBps.WithLabelValues(ethereumChain, id, name).Set(netBps)
	validatorGrossYieldBps.WithLabelValues(ethereumChain, id, name).Set(grossBps)
	validatorMevShareBps.WithLabelValues(ethereumChain, id, name).Set(0)
	validatorCommissionBps.WithLabelValues(ethereumChain, id, name).Set(0)
	validatorUptimePct.WithLabelValues(ethereumChain, id, name).Set(uptimePct)
	validatorStakeUSD.WithLabelValues(ethereumChain, id, name).Set(stakeUSD)
	validatorJailed.WithLabelValues(ethereumChain, id, name).Set(0)

	chainTotalValidators.WithLabelValues(ethereumChain).Set(1)
	chainMedianNetYieldBps.WithLabelValues(ethereumChain).Set(medianBps([]float64{netBps}))
	lastScrapeTimestamp.WithLabelValues(ethereumChain).Set(float64(time.Now().Unix()))

	fmt.Printf("[ethereum] published network-avg consensus APR %.1f bps (%.2fM ETH staked), ETH=$%.2f\n",
		netBps, stakedEth/1e6, ethPrice)
}
