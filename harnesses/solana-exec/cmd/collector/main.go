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

	h := helius.New(mustEnv("HELIUS_API_KEY"))

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

	// Fetch signatures newer than last seen. Results are newest-first.
	sigs, err := h.GetSignaturesForAddress(ctx, feeAccount, 100, cursor.LastSig)
	if err != nil {
		return fmt.Errorf("get sigs: %w", err)
	}
	if len(sigs) == 0 {
		return nil
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

	if len(sigStrs) == 0 {
		// All sigs in this batch were failed txs; advance cursor and skip.
		newest := sigs[0]
		return db.SaveCursor(ctx, plt, newest.Signature, newest.Slot)
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
