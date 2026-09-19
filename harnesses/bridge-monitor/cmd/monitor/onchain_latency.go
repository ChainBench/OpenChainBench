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

// settlementLatency replaces the wall-clock execution latency on a settled
// result with the on-chain one (destination block timestamp minus source
// block timestamp) when both hashes resolve. The wall clock is kept in
// ObservedLatencyMs for the audit trail. Returns the method used.
func (e *Executor) settlementLatency(result *ExecutionResult, fromChain, toChain, srcTx, dstTx string) string {
	result.ObservedLatencyMs = result.ExecutionLatencyMs
	if !result.Success || srcTx == "" || dstTx == "" {
		return "poll"
	}
	srcTs, err := e.txExecutor.TxBlockTime(fromChain, srcTx)
	if err != nil {
		log.Printf("    ⚠️  on-chain latency: source block time (%s %s): %v", fromChain, shortHash(srcTx), err)
		return "poll"
	}
	dstTs, err := e.txExecutor.TxBlockTime(toChain, dstTx)
	if err != nil {
		log.Printf("    ⚠️  on-chain latency: destination block time (%s %s): %v", toChain, shortHash(dstTx), err)
		return "poll"
	}
	d := dstTs.Sub(srcTs)
	if d < 0 {
		log.Printf("    ⚠️  on-chain latency: destination block %s before source block %s, keeping the wall clock", dstTs.UTC().Format(time.RFC3339), srcTs.UTC().Format(time.RFC3339))
		return "poll"
	}
	result.ExecutionLatencyMs = d.Milliseconds()
	result.DestTxHash = dstTx
	log.Printf("    ⏱  on-chain settlement: %s -> %s = %dms (wall clock %dms)", srcTs.UTC().Format("15:04:05"), dstTs.UTC().Format("15:04:05"), result.ExecutionLatencyMs, result.ObservedLatencyMs)
	return "onchain"
}

func shortHash(h string) string {
	if len(h) > 12 {
		return h[:12] + "…"
	}
	return h
}
