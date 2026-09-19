package main

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// On-chain settlement latency.
//
// Until 2026-09-19 the execution latency of every provider was the wall
// clock between our broadcast and the moment a 5-second status poll (plus
// the provider's indexing lag) first reported a terminal state. Every fill
// under 5 s therefore read 5.x s, and the table showed Mobula 5.29 s,
// Relay 5.53 s, LI.FI 5.82 s: the poll cadence, not the bridges.
//
// The settlement is a fact both chains record: the block that included our
// deposit on the source chain and the block that included the fill on the
// destination chain. Their timestamps give the latency at block resolution
// (Base 2 s, Arbitrum ~0.25 s, Solana ~0.4 s, all reported in whole
// seconds by the chains) with no dependence on how often we ask the
// provider. Every provider we execute on returns the destination hash in
// its status payload (Mobula toTxHash, LI.FI receiving.txHash, Relay
// txHashes, 1Click destinationChainTxHashes).
//
// When a hash is missing the wall clock stays, flagged by
// bridge_execution_latency_fallback_total so the share is visible.

// TxBlockTime returns the timestamp of the block that included txHash on
// chain ("Solana", "Base", "Arbitrum"). Retries briefly: a destination
// transaction can be reported by the provider a second before the public
// RPC serves it.
func (tx *TxExecutor) TxBlockTime(chain, txHash string) (time.Time, error) {
	var last error
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			time.Sleep(2 * time.Second)
		}
		t, err := tx.txBlockTimeOnce(chain, txHash)
		if err == nil {
			return t, nil
		}
		last = err
	}
	return time.Time{}, last
}

func (tx *TxExecutor) txBlockTimeOnce(chain, txHash string) (time.Time, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	switch strings.ToLower(chain) {
	case "solana":
		if tx.solanaClient == nil {
			return time.Time{}, fmt.Errorf("solana client not configured")
		}
		sig, err := solana.SignatureFromBase58(txHash)
		if err != nil {
			return time.Time{}, fmt.Errorf("bad solana signature %q: %w", txHash, err)
		}
		maxV := uint64(0)
		out, err := tx.solanaClient.GetTransaction(ctx, sig, &rpc.GetTransactionOpts{
			Commitment:                     rpc.CommitmentConfirmed,
			MaxSupportedTransactionVersion: &maxV,
		})
		if err != nil {
			return time.Time{}, err
		}
		if out == nil || out.BlockTime == nil {
			return time.Time{}, fmt.Errorf("solana tx %s has no blockTime yet", txHash)
		}
		return out.BlockTime.Time(), nil
	case "base", "arbitrum":
		client := tx.baseClient
		if strings.ToLower(chain) == "arbitrum" {
			client = tx.arbitrumClient
		}
		if client == nil {
			return time.Time{}, fmt.Errorf("%s client not configured", chain)
		}
		receipt, err := client.TransactionReceipt(ctx, common.HexToHash(txHash))
		if err != nil {
			return time.Time{}, err
		}
		header, err := client.HeaderByNumber(ctx, new(big.Int).Set(receipt.BlockNumber))
		if err != nil {
			return time.Time{}, err
		}
		return time.Unix(int64(header.Time), 0), nil
	default:
		return time.Time{}, fmt.Errorf("unsupported chain for block time: %s", chain)
	}
}

// settlementLatency sets the published latency of a settled result, in
// this order of preference:
//  1. watch: destination credit observed minus source inclusion observed
//     (millisecond, one clock, fill_watcher.go);
//  2. watch-broadcast: credit observed minus our broadcast time, when the
//     source watcher missed the inclusion;
//  3. blocks: destination block timestamp minus source block timestamp;
//  4. poll: the wall clock to the status poll (the pre-2026-09-19 figure).
//
// The block delta is always computed when both hashes resolve and kept in
// OnchainBlockDeltaMs as the cross-check; the poll figure stays in
// ObservedLatencyMs. Returns the method used.
func (e *Executor) settlementLatency(result *ExecutionResult, fromChain, toChain, srcTx, dstTx string) string {
	result.ObservedLatencyMs = result.ExecutionLatencyMs
	result.OnchainBlockDeltaMs = -1
	if !result.Success {
		return "poll"
	}
	result.DestTxHash = dstTx

	// Block delta (cross-check), independent of the watch.
	if srcTx != "" && dstTx != "" {
		srcTs, err1 := e.txExecutor.TxBlockTime(fromChain, srcTx)
		dstTs, err2 := e.txExecutor.TxBlockTime(toChain, dstTx)
		switch {
		case err1 != nil:
			log.Printf("    ⚠️  block delta: source block time (%s %s): %v", fromChain, shortHash(srcTx), err1)
		case err2 != nil:
			log.Printf("    ⚠️  block delta: destination block time (%s %s): %v", toChain, shortHash(dstTx), err2)
		case dstTs.Before(srcTs):
			log.Printf("    ⚠️  block delta: destination block %s before source block %s", dstTs.UTC().Format(time.RFC3339), srcTs.UTC().Format(time.RFC3339))
		default:
			result.OnchainBlockDeltaMs = dstTs.Sub(srcTs).Milliseconds()
		}
	}

	method := "poll"
	if w := e.watch; w != nil {
		credit := w.awaitCredit(20 * time.Second)
		broadcast, confirmed, _ := w.get()
		logWatch(result.Bridge, w)
		switch {
		case !credit.IsZero() && !confirmed.IsZero() && credit.After(confirmed):
			result.ExecutionLatencyMs = credit.Sub(confirmed).Milliseconds()
			method = "watch"
		case !credit.IsZero() && !broadcast.IsZero() && credit.After(broadcast):
			result.ExecutionLatencyMs = credit.Sub(broadcast).Milliseconds()
			method = "watch-broadcast"
		}
	}
	if method == "poll" && result.OnchainBlockDeltaMs >= 0 {
		result.ExecutionLatencyMs = result.OnchainBlockDeltaMs
		method = "blocks"
	}
	log.Printf("    ⏱  settlement latency: %dms (%s); block delta %dms; poll wall clock %dms",
		result.ExecutionLatencyMs, method, result.OnchainBlockDeltaMs, result.ObservedLatencyMs)
	return method
}

func shortHash(h string) string {
	if len(h) > 12 {
		return h[:12] + "…"
	}
	return h
}
