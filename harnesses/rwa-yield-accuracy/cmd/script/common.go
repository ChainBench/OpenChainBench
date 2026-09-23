package main

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// erc20TotalSupplySelector is the 4-byte function selector for
// ERC-20 totalSupply(). Same across every ERC-20 on every EVM chain.
var erc20TotalSupplySelector = common.Hex2Bytes("18160ddd")

// avgEthereumBlockTimeSec is used to translate a time delta into a
// block-number offset via a linear approximation. Post-merge Ethereum
// block time is 12s exactly and very stable, so this is accurate to
// within a few blocks over a 30-day window, well below the noise
// floor of a yield measurement.
const avgEthereumBlockTimeSec = 12

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
// Returns 0 if supplyStart is zero or invalid.
func annualizedYieldBps(supplyEnd, supplyStart, windowDays float64) int {
	if supplyStart <= 0 {
		return 0
	}
	growth := (supplyEnd - supplyStart) / supplyStart
	annualized := growth * (365.0 / windowDays)
	return int(annualized * 10000)
}

// navReader returns a NAV-like value as it stood at a block (nil = latest).
type navReader func(ctx context.Context, block *big.Int) (float64, error)

// printLookback bounds the search for the print behind a sampled value.
// The NAV sources step at most once a day and some only on business
// days, so a Friday print is 72 h old on Monday and 96 h after a holiday;
// five days covers that. A value still unchanged at the edge is an
// error, not an estimate: clamping to the edge moved the 30d yield about
// 12 bps either way twice a week on the business-day feeds (review
// 2026-09-23).
const printLookback = 5 * 24 * time.Hour

// windowYield is a print-anchored, compounded yield over a window.
type windowYield struct {
	Bps      int     // annualized yield in basis points, rounded
	SpanDays float64 // actual days between the two prints the yield spans
	NavEnd   float64
	NavStart float64
}

// printAnchoredYield measures growth between the NAV print in force now
// and the print in force `window` ago, and annualizes it, compounded,
// over the real time between those two prints. Reading at block offsets
// and dividing by exactly 30 days let the figure swing with the moment
// of sampling (USTB 328 to 389 bps over twenty days with a flat fund,
// audit 2026-09-23), because each sampled value is the last daily print,
// up to a day stale. A source that changes every block (an ERC-4626
// share price accruing per block) resolves to the sampled blocks
// themselves, so the same helper serves every adapter.
func printAnchoredYield(ctx context.Context, rpc *ethclient.Client, latest uint64, read navReader, window time.Duration) (*windowYield, error) {
	endBlock := new(big.Int).SetUint64(latest)
	navEnd, err := read(ctx, endBlock)
	if err != nil {
		return nil, fmt.Errorf("nav now: %w", err)
	}
	startBlock := blockOffsetBySeconds(latest, int64(window.Seconds()))
	navStart, err := read(ctx, startBlock)
	if err != nil {
		return nil, fmt.Errorf("nav %s: %w", window, err)
	}
	if navStart <= 0 || navEnd <= 0 {
		return nil, fmt.Errorf("nav out of range: start %.6f end %.6f", navStart, navEnd)
	}
	tEnd, err := printTime(ctx, rpc, read, endBlock, navEnd)
	if err != nil {
		return nil, fmt.Errorf("print time now: %w", err)
	}
	tStart, err := printTime(ctx, rpc, read, startBlock, navStart)
	if err != nil {
		return nil, fmt.Errorf("print time %s: %w", window, err)
	}
	span := tEnd.Sub(tStart)
	if span < window/2 {
		return nil, fmt.Errorf("print span %.1f days too short for a %s window", span.Hours()/24, window)
	}
	spanDays := span.Hours() / 24
	apy := math.Pow(navEnd/navStart, 365/spanDays) - 1
	return &windowYield{Bps: int(math.Round(apy * 10000)), SpanDays: spanDays, NavEnd: navEnd, NavStart: navStart}, nil
}

// printTime finds when the value read at `at` was printed: the lowest
// block in the lookback window that already carries it, by binary
// search (a NAV only moves forward, so "carries the same value" is
// monotone in the block number). A value older than the lookback is an
// error: the caller publishes nothing rather than a span guessed from
// the window edge.
func printTime(ctx context.Context, rpc *ethclient.Client, read navReader, at *big.Int, value float64) (time.Time, error) {
	lo := blockOffsetBySeconds(at.Uint64(), int64(printLookback.Seconds()))
	hi := new(big.Int).Set(at)
	same := func(b *big.Int) (bool, error) {
		v, err := read(ctx, b)
		if err != nil {
			return false, err
		}
		return math.Abs(v-value) <= math.Abs(value)*1e-12, nil
	}
	if ok, err := same(lo); err != nil {
		return time.Time{}, err
	} else if ok {
		return time.Time{}, fmt.Errorf("value unchanged for more than %s before block %s", printLookback, at)
	}
	for new(big.Int).Sub(hi, lo).Cmp(big.NewInt(1)) > 0 {
		mid := new(big.Int).Rsh(new(big.Int).Add(lo, hi), 1)
		ok, err := same(mid)
		if err != nil {
			return time.Time{}, err
		}
		if ok {
			hi = mid
		} else {
			lo = mid
		}
	}
	hdr, err := rpc.HeaderByNumber(ctx, hi)
	if err != nil {
		return time.Time{}, fmt.Errorf("header %s: %w", hi, err)
	}
	return time.Unix(int64(hdr.Time), 0).UTC(), nil
}
