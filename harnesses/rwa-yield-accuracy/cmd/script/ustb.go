package main

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// USTB is Superstate's Short-Duration U.S. Treasury Fund tokenized on
// Ethereum. NAV-accrual model: share price grows daily as yield accrues.
// There are no dividend transfers to holders — the "yield" materializes
// entirely through NAV growth.
//
// Contracts:
//   USTB ERC-20:         0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e
//   Chainlink NAV feed:  0x289B5036cd942e619E1Ee48670F98d214E745AAC
//     (Superstate publishes USTB NAV/USD via Chainlink, updates daily)
//
// Delivered yield is read directly from the Chainlink feed at latest
// and at t-30d / t-7d block numbers. No in-memory bootstrap needed
// (archive RPC provides history since token inception).

const (
	ustbContractEthereum = "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e"
	ustbChainlinkFeed    = "0x289B5036cd942e619E1Ee48670F98d214E745AAC"
)

type ustbProbe struct {
	contract common.Address
	navFeed  common.Address
}

func NewUSTBProbe() IssuerProbe {
	return &ustbProbe{
		contract: common.HexToAddress(ustbContractEthereum),
		navFeed:  common.HexToAddress(ustbChainlinkFeed),
	}
}

func (p *ustbProbe) Slug() string   { return "ustb" }
func (p *ustbProbe) Issuer() string { return "superstate" }
func (p *ustbProbe) Chain() string  { return "ethereum" }

func (p *ustbProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	latest, err := rpc.BlockNumber(ctx)
	if err != nil {
		return nil, fmt.Errorf("latest block: %w", err)
	}

	read := func(ctx context.Context, b *big.Int) (float64, error) {
		return readChainlinkNAV(ctx, rpc, p.navFeed, b)
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

	// USTB uses 6 decimals per Superstate spec.
	supply, err := readERC20TotalSupply(ctx, rpc, p.contract, nil)
	if err != nil {
		supply = 0
	}
	supplyUnits := supply / 1e6

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
