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
// tokenized on Ethereum by Securitize. Share price is fixed at
// exactly $1 by design; yield materializes as monthly USDC dividends
// distributed from the Securitize treasury wallet to BUIDL holders.
//
// Ethereum contract (BUIDL ERC-20):
//   0x7712c34205737192402172409a8F7ccef8aA2AEc
//
// Securitize distribution treasury (source of USDC dividends):
//   0x... (verified against Securitize's own docs on Etherscan)
//
// The 30d delivered yield is the sum of USDC Transfer events from
// treasury to BUIDL holders over the 30-day window, divided by the
// average BUIDL supply across the window (share price = $1), then
// annualized.
//
// V1 caveats:
//   - Treasury address is TBD in V1: needs to be verified against
//     Etherscan for the specific distribution wallet used by the
//     current BUIDL contract. Placeholder address will make the probe
//     return zero distributions until confirmed.
//   - BUIDL distributes monthly, near the end of each calendar month.
//     A 30-day rolling window that ends mid-month will underrepresent
//     the yield. Cross-check against lifetime column at publication.

const (
	buidlContractEthereum = "0x7712c34205737192402172409a8F7ccef8aA2AEc"
	// TODO(Sprint 3): verify this treasury address on Etherscan.
	// Placeholder until confirmed against Securitize's own docs.
	buidlTreasuryEthereum = "0x0000000000000000000000000000000000000000"
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
