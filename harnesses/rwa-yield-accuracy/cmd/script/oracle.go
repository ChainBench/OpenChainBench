package main

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// On-chain NAV oracle readers. Two shapes are supported here:
//
//   1. Chainlink AggregatorV3Interface — used by Superstate USTB.
//      latestRoundData() → (uint80, int256 answer, uint256, uint256, uint80)
//      decimals()        → uint8
//
//   2. Aave-style IPriceOracle — used by Ondo OUSG.
//      getAssetPrice(address asset) → uint256 (18 decimals, USD)
//     (Verified 2026-07 against 0x9Cad45a8...C094: returns $115.977
//      for OUSG which matches Ondo's dashboard.)
//
// Both are read with plain eth_call. Passing a non-nil blockNumber gives
// the historical value at that block, which is how we produce the t-30d
// and t-7d NAVs for windowed yield without maintaining an in-memory ring.

var (
	chainlinkLatestRoundDataSelector []byte
	oracleDecimalsSelector           []byte
	aaveGetAssetPriceSelector        []byte
)

func init() {
	chainlinkLatestRoundDataSelector = crypto.Keccak256([]byte("latestRoundData()"))[:4]
	oracleDecimalsSelector = crypto.Keccak256([]byte("decimals()"))[:4]
	aaveGetAssetPriceSelector = crypto.Keccak256([]byte("getAssetPrice(address)"))[:4]
}

// readChainlinkNAV reads a Chainlink AggregatorV3 feed and returns the
// answer scaled to a USD float using the feed's own decimals().
// blockNumber = nil reads the latest state; a specific big.Int reads
// the value that was current at that block (requires archive RPC).
func readChainlinkNAV(ctx context.Context, rpc *ethclient.Client, feed common.Address, blockNumber *big.Int) (float64, error) {
	dec, err := readOracleDecimals(ctx, rpc, feed, blockNumber)
	if err != nil {
		return 0, fmt.Errorf("decimals: %w", err)
	}

	msg := ethereum.CallMsg{
		To:   &feed,
		Data: chainlinkLatestRoundDataSelector,
	}
	result, err := rpc.CallContract(ctx, msg, blockNumber)
	if err != nil {
		return 0, fmt.Errorf("latestRoundData: %w", err)
	}
	if len(result) < 5*32 {
		return 0, fmt.Errorf("latestRoundData: short response %d bytes", len(result))
	}

	// Slot layout: [roundId | answer | startedAt | updatedAt | answeredInRound]
	// answer is int256; convert twos complement if negative (defensive —
	// NAV feeds never go negative in practice).
	answer := new(big.Int).SetBytes(result[32:64])
	if answer.Bit(255) == 1 {
		answer.Sub(answer, new(big.Int).Lsh(big.NewInt(1), 256))
	}
	return scaleByDecimals(answer, dec), nil
}

func readOracleDecimals(ctx context.Context, rpc *ethclient.Client, feed common.Address, blockNumber *big.Int) (uint8, error) {
	msg := ethereum.CallMsg{
		To:   &feed,
		Data: oracleDecimalsSelector,
	}
	result, err := rpc.CallContract(ctx, msg, blockNumber)
	if err != nil {
		return 0, err
	}
	if len(result) < 32 {
		return 0, fmt.Errorf("empty decimals response")
	}
	// uint8 sits in the last byte of the padded 32-byte word.
	return result[31], nil
}

// readAavePriceOracleNAV reads IPriceOracle.getAssetPrice(asset) and
// returns the 18-decimal USD price as a float. Used for OUSG (Ondo's
// oracle exposes an Aave-compatible interface).
func readAavePriceOracleNAV(ctx context.Context, rpc *ethclient.Client, oracle, asset common.Address, blockNumber *big.Int) (float64, error) {
	data := make([]byte, 0, 4+32)
	data = append(data, aaveGetAssetPriceSelector...)
	data = append(data, common.LeftPadBytes(asset.Bytes(), 32)...)

	msg := ethereum.CallMsg{
		To:   &oracle,
		Data: data,
	}
	result, err := rpc.CallContract(ctx, msg, blockNumber)
	if err != nil {
		return 0, err
	}
	if len(result) < 32 {
		return 0, fmt.Errorf("getAssetPrice: short response")
	}
	price := new(big.Int).SetBytes(result[0:32])
	return scaleByDecimals(price, 18), nil
}

func scaleByDecimals(v *big.Int, dec uint8) float64 {
	f, _ := new(big.Float).SetInt(v).Float64()
	scale := 1.0
	for i := uint8(0); i < dec; i++ {
		scale *= 10
	}
	return f / scale
}
