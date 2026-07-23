package main

import (
	"context"
	"fmt"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// USTB is Superstate's Short-Duration U.S. Treasury Fund tokenized
// on Ethereum. Same distribution model as BUIDL: share price fixed
// at $1, monthly USDC dividends distributed from the fund's treasury
// wallet.
//
// Ethereum contract (USTB ERC-20):
//   0x43415eB6f9c1D19a41BC1c17D7D1e9E92dB4B4aE
//
// Superstate treasury wallet (source of USDC dividends):
//   0x... (TODO Sprint 3: verify against Superstate's own docs)
//
// USTB uses 6 decimals per Superstate's specification.

const (
	ustbContractEthereum = "0x43415eB6f9c1D19a41BC1c17D7D1e9E92dB4B4aE"
	// TODO(Sprint 3): verify treasury address on Etherscan.
	ustbTreasuryEthereum = "0x0000000000000000000000000000000000000000"
)

type ustbProbe struct {
	contract common.Address
	treasury common.Address
}

func NewUSTBProbe() IssuerProbe {
	return &ustbProbe{
		contract: common.HexToAddress(ustbContractEthereum),
		treasury: common.HexToAddress(ustbTreasuryEthereum),
	}
}

func (p *ustbProbe) Slug() string   { return "ustb" }
func (p *ustbProbe) Issuer() string { return "superstate" }
func (p *ustbProbe) Chain() string  { return "ethereum" }

func (p *ustbProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

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

	supply30d, err := readERC20TotalSupply(ctx, rpc, p.contract, block30dAgo)
	if err != nil {
		return nil, fmt.Errorf("supply 30d: %w", err)
	}
	supply7d, err := readERC20TotalSupply(ctx, rpc, p.contract, block7dAgo)
	if err != nil {
		return nil, fmt.Errorf("supply 7d: %w", err)
	}

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

	// USTB is 6 decimals per Superstate spec. Share price = $1.
	avgSupply30dUSD := (supplyNow + supply30d) / 2 / 1e6
	avgSupply7dUSD := (supplyNow + supply7d) / 2 / 1e6

	yield30dBps := annualizedYieldBpsFromDistribution(dist30dUSD, avgSupply30dUSD, 30.0)
	yield7dBps := annualizedYieldBpsFromDistribution(dist7dUSD, avgSupply7dUSD, 7.0)

	supplyUnits := supplyNow / 1e6

	return &Measurement{
		Token:                p.Slug(),
		Issuer:               p.Issuer(),
		Chain:                p.Chain(),
		DeliveredBps30d:      yield30dBps,
		DeliveredBps7d:       yield7dBps,
		DeliveredBpsLifetime: 0, // V1 placeholder
		TotalSupplyUnits:     supplyUnits,
		AUMUSD:               supplyUnits,
		NewDistributionsUSD:  dist30dUSD,
		MeasuredAt:           now,
	}, nil
}
