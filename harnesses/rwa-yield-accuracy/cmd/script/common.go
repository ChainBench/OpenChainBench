package main

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
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
