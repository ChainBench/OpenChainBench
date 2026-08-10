package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/solana-exec/internal/helius"
	"github.com/ChainBench/OpenChainBench/harnesses/solana-exec/internal/platform"
	"github.com/ChainBench/OpenChainBench/harnesses/solana-exec/internal/store"
)

// baseFeePerSig is the fixed Solana base fee per signature in lamports.
const baseFeePerSig = 5000

func main() {
	ctx := context.Background()

	db, err := store.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("collector: %v", err)
	}
	defer db.Close()

	rpcURL := os.Getenv("SOLANA_RPC_URL")
	if rpcURL == "" {
		rpcURL = "https://api.mainnet-beta.solana.com"
	}
	h := helius.NewWithRPC(mustEnv("HELIUS_API_KEY"), rpcURL)

	log.Printf("collector: monitoring %d platforms", len(platform.FeeAccounts))

	for {
		for plt, feeAccount := range platform.FeeAccounts {
			if err := collect(ctx, db, h, plt, feeAccount); err != nil {
				log.Printf("collector: %s: %v", plt, err)
			}
		}
		time.Sleep(10 * time.Minute)
	}
}

func collect(ctx context.Context, db *store.DB, h *helius.Client, plt, feeAccount string) error {
	cursor, err := db.GetCursor(ctx, plt)
	if err != nil {
		return fmt.Errorf("get cursor: %w", err)
	}

	// Solana RPC supports up to 1000 sigs per getSignaturesForAddress call.
	// Using 1000 reduces page count ~10x vs 100: 45K sigs = 45 pages instead of 450.
	const sigLimit = 1000
	var sigs []helius.SigEntry
	before := ""
	for {
		batch, err := h.GetSignaturesForAddress(ctx, feeAccount, sigLimit, cursor.LastSig, before)
		if err != nil {
			return fmt.Errorf("get sigs (before=%s): %w", before, err)
		}
		sigs = append(sigs, batch...)
		if len(batch) < sigLimit {
			break // last page
		}
		before = batch[len(batch)-1].Signature
		time.Sleep(100 * time.Millisecond) // Helius free-tier RPC: 10 req/s max
	}
	if len(sigs) == 0 {
		return nil
	}
	if len(sigs) > sigLimit {
		log.Printf("collector: %s: paginated %d raw sigs (%d pages)", plt, len(sigs), (len(sigs)+sigLimit-1)/sigLimit)
	}

	// Reverse to process oldest-first so cursor is always the true watermark.
	reversed := make([]helius.SigEntry, len(sigs))
	for i, s := range sigs {
		reversed[len(sigs)-1-i] = s
	}

	// Pre-filter failed txs to avoid wasting enhanced-API credits.
	// Failed txs don't generate platform fees; priority-fee stats should reflect
	// the cost of successful trades only.
	var sigStrs []string
	for _, s := range reversed {
		if s.Err == nil {
			sigStrs = append(sigStrs, s.Signature)
		}
	}

	// Count successful sigs per hour bucket from raw pagination (full volume, no enhanced API cost).
	hourBuckets := make(map[time.Time]int64)
	for _, s := range reversed {
		if s.Err != nil || s.BlockTime == 0 {
			continue
		}
		bucket := time.Unix(s.BlockTime, 0).UTC().Truncate(time.Hour)
		hourBuckets[bucket]++
	}
	if err := db.UpsertRawCounts(ctx, plt, cursor.LastSig, hourBuckets); err != nil {
		return fmt.Errorf("upsert raw counts: %w", err)
	}

	if len(sigStrs) == 0 {
		// All sigs in this batch were failed txs; advance cursor and skip.
		newest := sigs[0]
		return db.SaveCursor(ctx, plt, newest.Signature, newest.Slot)
	}

	// Cap enhanced API at 100 sigs per poll (Helius free-tier budget: ~432K CUs/month).
	// Evenly stride across the window so the sample represents the full period, not just the oldest txs.
	if len(sigStrs) > 100 {
		step := len(sigStrs) / 100
		sampled := make([]string, 0, 100)
		for i := 0; i < len(sigStrs) && len(sampled) < 100; i += step {
			sampled = append(sampled, sigStrs[i])
		}
		sigStrs = sampled
	}

	txs, err := h.GetEnhancedTransactions(ctx, sigStrs)
	if err != nil {
		return fmt.Errorf("get enhanced txs: %w", err)
	}

	events := make([]store.ExecEvent, 0, len(txs))
	for _, tx := range txs {
		if tx.TransactionError != nil || tx.Timestamp == 0 {
			continue
		}

		priorityFee := tx.Fee - baseFeePerSig
		if priorityFee < 0 {
			priorityFee = 0
		}

		var platformFeeLamports, jitoTipLamports int64
		isJito := false
		for _, xfer := range tx.NativeTransfers {
			if xfer.ToUserAccount == feeAccount {
				platformFeeLamports += xfer.Amount
			}
			if platform.JitoTipAccounts[xfer.ToUserAccount] {
				jitoTipLamports += xfer.Amount
				isJito = true
			}
		}

		var cuPriceMicro int64
		if tx.ComputeUnitsConsumed > 0 && priorityFee > 0 {
			cuPriceMicro = priorityFee * 1_000_000 / tx.ComputeUnitsConsumed
		}

		events = append(events, store.ExecEvent{
			Sig:                 tx.Signature,
			Platform:            plt,
			Slot:                tx.Slot,
			BlockTime:           time.Unix(tx.Timestamp, 0).UTC(),
			TotalFeeLamports:    tx.Fee,
			PriorityFeeLamports: priorityFee,
			PlatformFeeLamports: platformFeeLamports,
			IsJitoBundle:        isJito,
			JitoTipLamports:     jitoTipLamports,
			CUConsumed:          tx.ComputeUnitsConsumed,
			CUPriceMicro:        cuPriceMicro,
		})
	}

	if err := db.UpsertEvents(ctx, events); err != nil {
		return fmt.Errorf("upsert: %w", err)
	}

	// Store raw CU price samples for true percentile computation (not AVG of hourly p50).
	cuSamples := make([]store.CUSample, 0, len(events))
	for _, e := range events {
		if e.CUPriceMicro > 0 {
			cuSamples = append(cuSamples, store.CUSample{Sig: e.Sig, BlockTime: e.BlockTime, CUPriceMicro: e.CUPriceMicro})
		}
	}
	if err := db.InsertCUSamples(ctx, plt, cuSamples); err != nil {
		return fmt.Errorf("insert cu samples: %w", err)
	}

	// Advance cursor to the newest sig (first in original order = last in reversed).
	newest := sigs[0]
	if err := db.SaveCursor(ctx, plt, newest.Signature, newest.Slot); err != nil {
		return fmt.Errorf("save cursor: %w", err)
	}

	log.Printf("collector: %s: ingested %d txs (newest slot %d)", plt, len(events), newest.Slot)
	return nil
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing env: %s", key)
	}
	return v
}
