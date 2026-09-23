package main

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// OUSG is Ondo's Short-Term U.S. Government Treasuries token. NAV
// appreciation model: share price grows daily as yield accrues.
//
// Contracts:
//   OUSG ERC-20:  0x1B19C19393e2d034D8Ff31fF34c81252FcBbee92
//   OndoOracle:   0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094
//     (Exposes Aave IPriceOracle interface: getAssetPrice(OUSG) →
//      18-decimal USD NAV. Verified 2026-07: returns $115.977, matches
//      Ondo's public dashboard.)
//
// The oracle read at a specific historical block gives the NAV that
// was current at that block, which is exactly the input we need for
// windowed yield without any off-chain HTTP dependency.

const (
	ousgContractEthereum = "0x1B19C19393e2d034D8Ff31fF34c81252FcBbee92"
	ousgOndoOracle       = "0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094"
)

type ousgProbe struct {
	contract common.Address
	oracle   common.Address
}

func NewOUSGProbe() IssuerProbe {
	return &ousgProbe{
		contract: common.HexToAddress(ousgContractEthereum),
		oracle:   common.HexToAddress(ousgOndoOracle),
	}
}

func (p *ousgProbe) Slug() string   { return "ousg" }
func (p *ousgProbe) Issuer() string { return "ondo" }
func (p *ousgProbe) Chain() string  { return "ethereum" }

func (p *ousgProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	latest, err := rpc.BlockNumber(ctx)
	if err != nil {
		return nil, fmt.Errorf("latest block: %w", err)
	}

	read := func(ctx context.Context, b *big.Int) (float64, error) {
		return readAavePriceOracleNAV(ctx, rpc, p.oracle, p.contract, b)
	}
	w30, err := printAnchoredYield(ctx, rpc, latest, read, Window30d)
	if err != nil {
		return nil, fmt.Errorf("30d: %w", err)
	}
	w7, err := printAnchoredYield(ctx, rpc, latest, read, Window7d)
	if err != nil {
		return nil, fmt.Errorf("7d: %w", err)
	}
	navNow := w30.NavEnd
	yield30dBps, yield7dBps := w30.Bps, w7.Bps

	supply, err := readERC20TotalSupply(ctx, rpc, p.contract, nil)
	if err != nil {
		supply = 0
	}
	supplyUnits := supply / 1e18

	return &Measurement{
		Token:                p.Slug(),
		Issuer:               p.Issuer(),
		Chain:                p.Chain(),
		DeliveredBps30d:      yield30dBps,
		DeliveredBps7d:       yield7dBps,
		SpanDays30d:          w30.SpanDays,
		SpanDays7d:           w7.SpanDays,
		DeliveredBpsLifetime: 0,
		TotalSupplyUnits:     supplyUnits,
		AUMUSD:               supplyUnits * navNow,
		NewDistributionsUSD:  0,
		MeasuredAt:           now,
	}, nil
}
