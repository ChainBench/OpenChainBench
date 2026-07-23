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

// USDY is Ondo's yield-bearing tokenized U.S. Treasury note. Rebase
// mechanism: totalSupply grows daily via the smart contract as yield
// accrues. Delivered yield is a pure function of totalSupply growth
// over the window, no dividend transfers, no NAV oracle needed.
//
// Ethereum contract:
//   0x96F6eF951840721AdBF46Ac996b59E0235CB985C  (Ondo USDY, ERC-20 proxy)
//
// The token has 18 decimals. Share price is exactly $1 by rebase
// construction: 1 USDY (at any point in time) equals 1 USD of face
// value. Yield materializes as more USDY units in each holder's wallet,
// not as share price appreciation.
//
// Multi-chain note: USDY also lives on Solana, Aptos and Sui. V1
// measures Ethereum only. V2 will aggregate cross-chain supply.

const usdyContractEthereum = "0x96F6eF951840721AdBF46Ac996b59E0235CB985C"

// erc20TotalSupplySelector is the 4-byte function selector for
// ERC-20 totalSupply(). Same across every ERC-20 on every EVM chain.
var erc20TotalSupplySelector = common.Hex2Bytes("18160ddd")

// avgEthereumBlockTimeSec is used to translate a 30-day / 7-day time
// delta into a block-number offset via a linear approximation. Post-
// merge Ethereum block time is 12s exactly and very stable, so this
// approximation is accurate to within a few blocks over a 30-day
// window, which is well below the noise floor of a yield measurement.
const avgEthereumBlockTimeSec = 12

type usdyProbe struct {
	contract common.Address
}

// NewUSDYProbe constructs the USDY probe with the mainnet contract
// address hardcoded. Exposed as an IssuerProbe.
func NewUSDYProbe() IssuerProbe {
	return &usdyProbe{
		contract: common.HexToAddress(usdyContractEthereum),
	}
}

func (p *usdyProbe) Slug() string   { return "usdy" }
func (p *usdyProbe) Issuer() string { return "ondo" }
func (p *usdyProbe) Chain() string  { return "ethereum" }

func (p *usdyProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	// Current supply (latest block).
	supplyNow, err := p.readTotalSupply(ctx, rpc, nil)
	if err != nil {
		return nil, fmt.Errorf("supply now: %w", err)
	}

	// Approximate the block numbers for t-30d and t-7d using the
	// stable post-merge 12s block time. Precision is ~10 blocks over
	// 30 days, well below the noise floor of an APY measurement.
	latest, err := rpc.BlockNumber(ctx)
	if err != nil {
		return nil, fmt.Errorf("latest block: %w", err)
	}
	block30dAgo := blockOffsetBySeconds(latest, int64(Window30d.Seconds()))
	block7dAgo := blockOffsetBySeconds(latest, int64(Window7d.Seconds()))

	supply30d, err := p.readTotalSupply(ctx, rpc, block30dAgo)
	if err != nil {
		return nil, fmt.Errorf("supply 30d: %w", err)
	}
	supply7d, err := p.readTotalSupply(ctx, rpc, block7dAgo)
	if err != nil {
		return nil, fmt.Errorf("supply 7d: %w", err)
	}

	// Annualized delivered yields, in basis points.
	yield30dBps := annualizedYieldBps(supplyNow, supply30d, 30.0)
	yield7dBps := annualizedYieldBps(supplyNow, supply7d, 7.0)

	// Lifetime yield placeholder for V1. V2 will read the contract
	// deployment block from Etherscan and compute since inception.
	yieldLifeBps := 0

	supplyUnits := supplyNow / 1e18

	return &Measurement{
		Token:                p.Slug(),
		Issuer:               p.Issuer(),
		Chain:                p.Chain(),
		DeliveredBps30d:      yield30dBps,
		DeliveredBps7d:       yield7dBps,
		DeliveredBpsLifetime: yieldLifeBps,
		TotalSupplyUnits:     supplyUnits,
		AUMUSD:               supplyUnits, // 1 USDY == 1 USD by rebase construction
		NewDistributionsUSD:  0,           // rebase model, no dividend transfers
		MeasuredAt:           now,
	}, nil
}

// readTotalSupply calls the ERC-20 totalSupply() view function at the
// given block number (nil = latest) and returns the raw uint256 as a
// float64 (in wei-equivalent units, 1e18 for USDY).
func (p *usdyProbe) readTotalSupply(ctx context.Context, rpc *ethclient.Client, blockNumber *big.Int) (float64, error) {
	msg := ethereum.CallMsg{
		To:   &p.contract,
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

// blockOffsetBySeconds returns latest - (deltaSeconds / avgBlockTime),
// clamped to 1. Used to approximate the block number a given time
// ago without a per-block binary search.
func blockOffsetBySeconds(latest uint64, deltaSeconds int64) *big.Int {
	offset := uint64(deltaSeconds) / avgEthereumBlockTimeSec
	if offset >= latest {
		return big.NewInt(1)
	}
	return new(big.Int).SetUint64(latest - offset)
}

// annualizedYieldBps computes (supplyEnd - supplyStart) / supplyStart,
// annualized from a windowDays-day period, expressed in basis points.
// Returns 0 if supplyStart is zero or invalid (protection against
// division by zero on very fresh tokens).
func annualizedYieldBps(supplyEnd, supplyStart, windowDays float64) int {
	if supplyStart <= 0 {
		return 0
	}
	growth := (supplyEnd - supplyStart) / supplyStart
	annualized := growth * (365.0 / windowDays)
	return int(annualized * 10000)
}
