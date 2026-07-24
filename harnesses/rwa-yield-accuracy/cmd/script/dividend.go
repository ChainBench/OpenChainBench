package main

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Shared helpers for the dividend distribution model (BUIDL, USTB).
//
// Delivered yield for a dividend-model token is:
//
//     yield = sum(USDC Transfer events from treasury_wallet to any holder,
//                 over the window)
//             / avg(token totalSupply across the window)
//             * (365 / window_days)
//
// The treasury wallet is the address the issuer uses to distribute
// monthly dividends in USDC. It's public information for each fund but
// must be verified against the fund's own documentation before trusting
// the numbers.
//
// USDC contract on Ethereum mainnet:
//   0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
// Transfer event signature:
//   keccak256("Transfer(address,address,uint256)") =
//   0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef

const usdcContractEthereum = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

var transferTopic = common.HexToHash("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

// sumUSDCDistributionsFromTreasury queries all USDC Transfer events
// with `from = treasury` over [fromBlock, toBlock] and returns the
// total USDC amount transferred, in USDC base units (6 decimals).
//
// Chunks the block range into eth_getLogs-friendly slices (10_000
// blocks each) since some public RPCs cap the range or the response
// size. Failing on a chunk aborts the whole call so the caller sees a
// clear "measurement failed" rather than a silently truncated total.
func sumUSDCDistributionsFromTreasury(
	ctx context.Context,
	rpc *ethclient.Client,
	treasury common.Address,
	fromBlock, toBlock uint64,
) (*big.Int, error) {
	usdc := common.HexToAddress(usdcContractEthereum)
	// Topic filter: [Transfer, from=treasury, ANY to]. Address is
	// padded to 32 bytes (left-padded with zeros) per event topic
	// encoding rules.
	fromTopic := common.BytesToHash(treasury.Bytes())

	const chunk = uint64(10_000)
	total := new(big.Int)

	for start := fromBlock; start <= toBlock; start += chunk {
		end := start + chunk - 1
		if end > toBlock {
			end = toBlock
		}
		q := ethereum.FilterQuery{
			FromBlock: new(big.Int).SetUint64(start),
			ToBlock:   new(big.Int).SetUint64(end),
			Addresses: []common.Address{usdc},
			Topics: [][]common.Hash{
				{transferTopic},
				{fromTopic},
				nil, // any recipient
			},
		}
		logs, err := rpc.FilterLogs(ctx, q)
		if err != nil {
			return nil, fmt.Errorf("filterLogs [%d..%d]: %w", start, end, err)
		}
		for _, lg := range logs {
			// Transfer event data is the uint256 amount (32 bytes).
			// Anonymous events would put value in topics; ERC-20 Transfer
			// is not anonymous so value is in data.
			if len(lg.Data) < 32 {
				continue
			}
			amount := new(big.Int).SetBytes(lg.Data[:32])
			total.Add(total, amount)
		}
	}
	return total, nil
}

// usdcAmountToFloat converts a USDC base-unit amount (6 decimals) to
// a float64 in USD.
func usdcAmountToFloat(raw *big.Int) float64 {
	if raw == nil {
		return 0
	}
	f, _ := new(big.Float).SetInt(raw).Float64()
	return f / 1e6
}

// annualizedYieldBpsFromDistribution computes annualized delivered
// yield for a dividend-model token, given a distribution total (in
// USD) over a windowDays period and the average supply of the token
// (in USD, treating share price as $1 per BUIDL/USTB design).
func annualizedYieldBpsFromDistribution(distributionUSD, avgSupplyUSD, windowDays float64) int {
	if avgSupplyUSD <= 0 {
		return 0
	}
	periodYield := distributionUSD / avgSupplyUSD
	annualized := periodYield * (365.0 / windowDays)
	return int(annualized * 10000)
}
