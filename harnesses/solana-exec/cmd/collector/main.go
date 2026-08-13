package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
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
	h := helius.New(rpcURL)

	log.Printf("collector: monitoring %d platforms", len(platform.FeeAccounts))

	for {
		for plt, feeAccounts := range platform.FeeAccounts {
			if err := collect(ctx, db, h, plt, feeAccounts); err != nil {
				log.Printf("collector: %s: %v", plt, err)
			}
		}
		time.Sleep(10 * time.Minute)
	}
}

type acctData struct {
	cursorKey string
	cursor    store.Cursor
	sigs      []helius.SigEntry // newest-first from RPC
}

func collect(ctx context.Context, db *store.DB, h *helius.Client, plt string, feeAccounts []string) error {
	// SPL token mint for fee detection; empty = SOL (native lamports).
	feeToken := platform.FeeToken[plt]

	// feeSet is used to detect fee transfers in NativeTransfers / postTokenBalances.owner.
	// For SPL-token platforms (e.g. FOMO), FeeAccounts holds the ATA (for sig discovery)
	// but postTokenBalances.owner is the wallet — so use FeeOwners when present.
	feeOwners := platform.FeeOwners[plt]
	if feeOwners == nil {
		feeOwners = feeAccounts
	}
	feeSet := make(map[string]bool, len(feeOwners))
	for _, fa := range feeOwners {
		feeSet[fa] = true
	}

	// Paginate each fee account independently with its own cursor so a crash
	// between accounts doesn't cause re-processing of already-committed data.
	perAcct := make([]acctData, 0, len(feeAccounts))

	for _, feeAccount := range feeAccounts {
		cursorKey := plt + ":" + feeAccount
		cursor, err := db.GetCursor(ctx, cursorKey)
		if err != nil {
			return fmt.Errorf("get cursor %s: %w", feeAccount, err)
		}

		const sigLimit = 1000
		const maxPages = 300 // cap backfill at 300k sigs per account (~20 days for busy wallets)
		var sigs []helius.SigEntry
		before := ""
		for page := 0; page < maxPages; page++ {
			batch, err := h.GetSignaturesForAddress(ctx, feeAccount, sigLimit, cursor.LastSig, before)
			if err != nil {
				return fmt.Errorf("get sigs %s (before=%s): %w", feeAccount, before, err)
			}
			sigs = append(sigs, batch...)
			if len(batch) < sigLimit {
				break
			}
			before = batch[len(batch)-1].Signature
			time.Sleep(100 * time.Millisecond)
		}
		if len(sigs) > sigLimit {
			log.Printf("collector: %s: %s: paginated %d sigs", plt, feeAccount, len(sigs))
		}

		perAcct = append(perAcct, acctData{cursorKey: cursorKey, cursor: cursor, sigs: sigs})
	}

	// Merge sigs from all accounts, de-duplicate by signature.
	// A single tx can touch multiple fee accounts of the same platform (rare but possible).
	seen := make(map[string]struct{})
	var allSigs []helius.SigEntry
	for _, acct := range perAcct {
		for _, s := range acct.sigs {
			if _, dup := seen[s.Signature]; dup {
				continue
			}
			seen[s.Signature] = struct{}{}
			allSigs = append(allSigs, s)
		}
	}

	if len(allSigs) == 0 {
		return nil
	}

	// Count raw hourly volume from the merged+deduped sig set so a tx touching
	// multiple fee accounts of the same platform is counted exactly once.
	// from_cursor is a compound of all account cursors for idempotency on retry.
	fromCursor := compoundCursor(perAcct)
	hourBuckets := make(map[time.Time]int64)
	for _, s := range allSigs {
		if s.Err != nil || s.BlockTime == 0 {
			continue
		}
		bucket := time.Unix(s.BlockTime, 0).UTC().Truncate(time.Hour)
		hourBuckets[bucket]++
	}
	if err := db.UpsertRawCounts(ctx, plt, fromCursor, hourBuckets); err != nil {
		return fmt.Errorf("upsert raw counts: %w", err)
	}

	// Pre-filter failed txs; only successful trades generate platform fees.
	var sigStrs []string
	for _, s := range allSigs {
		if s.Err == nil {
			sigStrs = append(sigStrs, s.Signature)
		}
	}

	// All sigs failed: still save cursors so we don't re-scan next poll.
	if len(sigStrs) == 0 {
		return saveCursors(ctx, db, perAcct)
	}

	// Sort by slot descending before striding so the sample is temporally uniform
	// across multi-account platforms (e.g. Axiom 20 accounts — merge order is arbitrary).
	sort.Slice(allSigs, func(i, j int) bool { return allSigs[i].Slot > allSigs[j].Slot })

	// Rebuild sigStrs from the sorted order after filtering failed txs.
	sigStrs = sigStrs[:0]
	for _, s := range allSigs {
		if s.Err == nil {
			sigStrs = append(sigStrs, s.Signature)
		}
	}

	// Cap enhanced API at 100 sigs; stride-sample across the full window so the
	// sample represents the whole poll period, not just the most recent transactions.
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

		if feeToken == "" {
			// SOL-fee platform: detect via native SOL transfers.
			// Skip any tx where a fee wallet is also a sender — these are internal sweeps
			// (e.g. Axiom consolidating 20 wallets) that would inflate the average fee.
			hasFeeWalletSender := false
			for _, sender := range tx.SenderAccounts {
				if feeSet[sender] {
					hasFeeWalletSender = true
					break
				}
			}
			if !hasFeeWalletSender {
				for _, xfer := range tx.NativeTransfers {
					if feeSet[xfer.ToUserAccount] {
						platformFeeLamports += xfer.Amount
					}
				}
			}
			for _, xfer := range tx.NativeTransfers {
				if platform.JitoTipAccounts[xfer.ToUserAccount] {
					jitoTipLamports += xfer.Amount
					isJito = true
				}
			}
		} else {
			// SPL-token-fee platform (e.g. FOMO uses USDC): detect via token transfers.
			// platformFeeLamports stores raw token units (1 USDC = 1_000_000).
			for _, xfer := range tx.TokenTransfers {
				if feeSet[xfer.ToOwner] && xfer.Mint == feeToken {
					platformFeeLamports += xfer.Amount
				}
			}
			// Jito detection is SOL-based regardless of fee token.
			for _, xfer := range tx.NativeTransfers {
				if platform.JitoTipAccounts[xfer.ToUserAccount] {
					jitoTipLamports += xfer.Amount
					isJito = true
				}
			}
		}

		// CU price comes directly from SetComputeUnitPrice (disc 0x03), already in
		// micro-lamports per CU — no division needed. Only set when the instruction
		// is present; 0 means base fee only, not a zero-price priority tx.
		cuPriceMicro := tx.CUPriceDeclared

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

	cuSamples := make([]store.CUSample, 0, len(events))
	for _, e := range events {
		if e.CUPriceMicro > 0 {
			cuSamples = append(cuSamples, store.CUSample{Sig: e.Sig, BlockTime: e.BlockTime, CUPriceMicro: e.CUPriceMicro})
		}
	}
	if err := db.InsertCUSamples(ctx, plt, cuSamples); err != nil {
		return fmt.Errorf("insert cu samples: %w", err)
	}

	if err := saveCursors(ctx, db, perAcct); err != nil {
		return err
	}

	log.Printf("collector: %s: ingested %d events", plt, len(events))
	return nil
}

// compoundCursor returns a deterministic string that encodes the cursor state for
// all accounts in this poll, used as the from_cursor idempotency key in raw_counts.
func compoundCursor(perAcct []acctData) string {
	if len(perAcct) == 0 {
		return ""
	}
	parts := make([]string, 0, len(perAcct))
	for _, a := range perAcct {
		parts = append(parts, a.cursorKey+"="+a.cursor.LastSig)
	}
	return strings.Join(parts, ",")
}

// saveCursors advances each fee account's cursor to its newest observed sig.
func saveCursors(ctx context.Context, db *store.DB, perAcct []acctData) error {
	for _, acct := range perAcct {
		if len(acct.sigs) == 0 {
			continue
		}
		newest := acct.sigs[0] // RPC returns newest-first
		if err := db.SaveCursor(ctx, acct.cursorKey, newest.Signature, newest.Slot); err != nil {
			return fmt.Errorf("save cursor %s: %w", acct.cursorKey, err)
		}
	}
	return nil
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing env: %s", key)
	}
	return v
}
