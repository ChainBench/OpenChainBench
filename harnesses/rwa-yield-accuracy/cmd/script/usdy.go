package main

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// USDY is Ondo's yield-bearing tokenized U.S. Treasury note.
//
// Naive "measure rebase via totalSupply growth" breaks on Ethereum:
// USDY is issued on Ethereum, Solana, Aptos, Sui, and bridge
// burns/mints on the Ethereum side dominate any short-window delta.
// In practice Ethereum totalSupply SHRINKS as holders migrate to
// Solana, so a naive rate calculation reports negative APY even
// though the underlying yield accrual is steady.
//
// Fix: use Ondo's on-chain oracle — same one OUSG reads. USDY is
// registered there via IPriceOracle.getAssetPrice(USDY), returning
// an 18-decimal USD price that grows monotonically with pure yield
// accrual, independent of bridge / subscription / redemption flow.
// Verified 2026-07: 1.140485 today, 1.137220 30d ago → annualized
// 3.49% APY, matching Ondo's advertised 3.55% within 6 bps.
//
// Contracts:
//   USDY ERC-20:  0x96F6eF951840721AdBF46Ac996b59E0235CB985C
//   OndoOracle:   0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094
//     (Aave-style IPriceOracle, shared with OUSG.)

const (
	usdyContractEthereum = "0x96F6eF951840721AdBF46Ac996b59E0235CB985C"
	usdyOndoOracle       = "0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094"
)

type usdyProbe struct {
	contract common.Address
	oracle   common.Address
}

func NewUSDYProbe() IssuerProbe {
	return &usdyProbe{
		contract: common.HexToAddress(usdyContractEthereum),
		oracle:   common.HexToAddress(usdyOndoOracle),
	}
}

func (p *usdyProbe) Slug() string   { return "usdy" }
func (p *usdyProbe) Issuer() string { return "ondo" }
func (p *usdyProbe) Chain() string  { return "ethereum" }

func (p *usdyProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
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

	// Ethereum-side supply for AUM proxy. USDY is 18 decimals.
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
