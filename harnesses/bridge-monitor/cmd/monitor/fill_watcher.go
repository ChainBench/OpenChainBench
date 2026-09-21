package main

import (
	"context"
	"log"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Millisecond settlement latency.
//
// Block timestamps (onchain_latency.go) give the settlement at whole-second
// resolution, which is the chains' own precision and floors a sub-second
// fill at 0 s. For a millisecond figure the harness watches both ends
// itself, on one clock, at a fixed cadence:
//
//   - the destination: the recipient's token balance is read every
//     watchInterval from the moment before the deposit is broadcast; the
//     first read that exceeds the pre-execution balance stamps creditAt.
//   - the source: from the broadcast, the deposit's receipt (EVM) or
//     signature status (Solana, any commitment from processed) is read
//     every watchInterval; the first read that shows it included stamps
//     confirmedAt.
//
// bridge_exec_latency_ms = creditAt - confirmedAt: what the bridge took
// once the deposit was on-chain, observed with the same detection lag on
// both ends (at most one watchInterval plus one RPC round-trip, on keyed
// endpoints). The block-timestamp delta is published alongside as
// bridge_exec_onchain_ms and must agree to within about one destination
// block; the old poll wall clock stays as bridge_exec_observed_ms.
const watchInterval = 100 * time.Millisecond

type legWatch struct {
	mu          sync.Mutex
	broadcastAt time.Time
	confirmedAt time.Time
	creditAt    time.Time
	cancel      context.CancelFunc
	ctx         context.Context
}

func (w *legWatch) set(field *time.Time, t time.Time) {
	w.mu.Lock()
	if field.IsZero() {
		*field = t
	}
	w.mu.Unlock()
}

func (w *legWatch) get() (broadcast, confirmed, credit time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.broadcastAt, w.confirmedAt, w.creditAt
}

// startLegWatch begins watching the destination balance before the deposit
// is broadcast. One leg executes at a time (execMu), so a single watcher
// on the Executor is enough.
func (e *Executor) startLegWatch(toChain, toToken, receiver string, before *big.Int) {
	e.stopLegWatch()
	if before == nil || e.txExecutor == nil || e.txExecutor.dryRun {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	w := &legWatch{ctx: ctx, cancel: cancel}
	e.watch = w
	go func() {
		t := time.NewTicker(watchInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				now, err := e.txExecutor.readDestinationBalance(toChain, toToken, receiver)
				if err != nil || now == nil {
					continue
				}
				if now.Cmp(before) > 0 {
					w.set(&w.creditAt, time.Now())
					return
				}
			}
		}
	}()
}

// markBroadcast is called by every executor right after a successful
// broadcast: stamps broadcastAt and starts watching the source chain for
// the deposit's inclusion.
func (e *Executor) markBroadcast(fromChain, txHash string) {
	w := e.watch
	if w == nil || txHash == "" {
		return
	}
	w.set(&w.broadcastAt, time.Now())
	go func() {
		t := time.NewTicker(watchInterval)
		defer t.Stop()
		for {
			select {
			case <-w.ctx.Done():
				return
			case <-t.C:
				if e.txExecutor.txIncluded(fromChain, txHash) {
					w.set(&w.confirmedAt, time.Now())
					return
				}
			}
		}
	}()
}

func (e *Executor) stopLegWatch() {
	if e.watch != nil && e.watch.cancel != nil {
		e.watch.cancel()
	}
	e.watch = nil
}

// txIncluded reports whether txHash is in a block (any status) on chain.
func (tx *TxExecutor) txIncluded(chain, txHash string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	switch strings.ToLower(chain) {
	case "solana":
		if tx.solanaClient == nil {
			return false
		}
		sig, err := solana.SignatureFromBase58(txHash)
		if err != nil {
			return false
		}
		out, err := tx.solanaClient.GetSignatureStatuses(ctx, false, sig)
		if err != nil || out == nil || len(out.Value) == 0 || out.Value[0] == nil {
			return false
		}
		// Any commitment counts: a relayer acting on `processed` can credit
		// the destination before our `confirmed` stamp, which would make
		// credit precede inclusion and push the leg to the broadcast fallback.
		st := out.Value[0]
		return st.ConfirmationStatus == rpc.ConfirmationStatusProcessed ||
			st.ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
			st.ConfirmationStatus == rpc.ConfirmationStatusFinalized
	case "base", "arbitrum":
		client := tx.baseClient
		if strings.ToLower(chain) == "arbitrum" {
			client = tx.arbitrumClient
		}
		if client == nil {
			return false
		}
		r, err := client.TransactionReceipt(ctx, common.HexToHash(txHash))
		return err == nil && r != nil && r.BlockNumber != nil
	}
	return false
}

// awaitCredit gives the destination watcher a little time after the
// provider says "filled": the credit can land a block after the status.
func (w *legWatch) awaitCredit(max time.Duration) time.Time {
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		_, _, c := w.get()
		if !c.IsZero() {
			return c
		}
		time.Sleep(watchInterval)
	}
	_, _, c := w.get()
	return c
}

func logWatch(prefix string, w *legWatch) {
	b, c, cr := w.get()
	f := func(t time.Time) string {
		if t.IsZero() {
			return "-"
		}
		return t.UTC().Format("15:04:05.000")
	}
	log.Printf("    ⏱  %s watch: broadcast %s, source included %s, destination credited %s", prefix, f(b), f(c), f(cr))
}
