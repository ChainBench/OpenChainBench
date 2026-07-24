package main

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// BUIDL is BlackRock's USD Institutional Digital Liquidity Fund,
// tokenized on Ethereum by Securitize.
//
// Contracts:
//   BUIDL ERC-20:   0x7712c34205737192402172409a8F7ccef8aA2AEc
//   Distributor:    0x5072Ed40EBa6bE38C2370cAD1Cb1df0202924e53
//     (Securitize distribution EOA that calls bulkIssuance on BUIDL)
//
// DORMANT — mechanism mismatch. Research showed the distributor
// mints ADDITIONAL BUIDL rather than transferring USDC. The current
// dividend.go path (sum USDC Transfer events from treasury) reports
// zero for BUIDL and is the wrong model for this token.
//
// To activate, replace Measure with a rebase-style implementation
// that reads totalSupply growth over the window (like USDY) AND
// filters out mints attributable to new subscriptions vs yield
// accrual. Ondo/USDY separates these cleanly at the contract level;
// BUIDL does not, so cross-referencing with Securitize's monthly
// dividend announcements will likely be required to net out
// subscription-driven supply changes.

const (
	buidlContractEthereum = "0x7712c34205737192402172409a8F7ccef8aA2AEc"
	buidlTreasuryEthereum = "0x5072Ed40EBa6bE38C2370cAD1Cb1df0202924e53"
)

type buidlProbe struct {
	contract common.Address
	treasury common.Address
}

func NewBUIDLProbe() IssuerProbe {
	return &buidlProbe{
		contract: common.HexToAddress(buidlContractEthereum),
		treasury: common.HexToAddress(buidlTreasuryEthereum),
	}
}

func (p *buidlProbe) Slug() string   { return "buidl" }
func (p *buidlProbe) Issuer() string { return "blackrock" }
func (p *buidlProbe) Chain() string  { return "ethereum" }

func (p *buidlProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	// Current supply.
	supplyNow, err := readERC20TotalSupply(ctx, rpc, p.contract, nil)
	if err != nil {
		return nil, fmt.Errorf("supply now: %w", err)
	}

	latest, err := rpc.BlockNumber(ctx)
	if err != nil {
		return nil, fmt.Errorf("latest block: %w", err)
	}
	block30dAgo := blockOffsetBySeconds(latest, int64(Window30d.Seconds()))
	block7dAgo := blockOffsetBySeconds(latest, int64(Window7d.Seconds()))

	// Historical supplies for the avg-over-window denominator.
	supply30d, err := readERC20TotalSupply(ctx, rpc, p.contract, block30dAgo)
	if err != nil {
		return nil, fmt.Errorf("supply 30d: %w", err)
	}
	supply7d, err := readERC20TotalSupply(ctx, rpc, p.contract, block7dAgo)
	if err != nil {
		return nil, fmt.Errorf("supply 7d: %w", err)
	}

	// Distributions from treasury over each window.
	// BUIDL uses 6 decimals? Actually BUIDL is 6 decimals per Securitize
	// docs, matching USDC. Confirm at Sprint 3 verification pass.
	dist30d, err := sumUSDCDistributionsFromTreasury(ctx, rpc, p.treasury, block30dAgo.Uint64(), latest)
	if err != nil {
		return nil, fmt.Errorf("distributions 30d: %w", err)
	}
	dist7d, err := sumUSDCDistributionsFromTreasury(ctx, rpc, p.treasury, block7dAgo.Uint64(), latest)
	if err != nil {
		return nil, fmt.Errorf("distributions 7d: %w", err)
	}
	dist30dUSD := usdcAmountToFloat(dist30d)
	dist7dUSD := usdcAmountToFloat(dist7d)

	// BUIDL is 6 decimals like USDC. Share price = $1 by design.
	avgSupply30dUSD := (supplyNow + supply30d) / 2 / 1e6
	avgSupply7dUSD := (supplyNow + supply7d) / 2 / 1e6

	yield30dBps := annualizedYieldBpsFromDistribution(dist30dUSD, avgSupply30dUSD, 30.0)
	yield7dBps := annualizedYieldBpsFromDistribution(dist7dUSD, avgSupply7dUSD, 7.0)

	// Lifetime V1 placeholder. V2: sum distributions since contract
	// deployment block.
	yieldLifeBps := 0

	supplyUnits := supplyNow / 1e6
	aum := supplyUnits // share price $1 by design

	return &Measurement{
		Token:                p.Slug(),
		Issuer:               p.Issuer(),
		Chain:                p.Chain(),
		DeliveredBps30d:      yield30dBps,
		DeliveredBps7d:       yield7dBps,
		DeliveredBpsLifetime: yieldLifeBps,
		TotalSupplyUnits:     supplyUnits,
		AUMUSD:               aum,
		NewDistributionsUSD:  dist30dUSD, // reported for the counter
		MeasuredAt:           now,
	}, nil
}

// readERC20TotalSupply is the shared ERC-20 totalSupply() reader.
// Extracted from usdy.go for reuse across dividend-model probes.
func readERC20TotalSupply(ctx context.Context, rpc *ethclient.Client, contract common.Address, blockNumber *big.Int) (float64, error) {
	msg := ethereum.CallMsg{
		To:   &contract,
		Data: erc20TotalSupplySelector,
	}
	result, err := rpc.CallContract(ctx, msg, blockNumber)
	if err != nil {
		return 0, err
	}
	if len(result) == 0 {
		return 0, fmt.Errorf("empty call result")
	}
	supply := new(big.Int).SetBytes(result)
	f, _ := new(big.Float).SetInt(supply).Float64()
	return f, nil
}
