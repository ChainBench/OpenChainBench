package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

// Metrics server listens on :2112 — the OCB convention for every
// harness scraped by the shared Prometheus at
// <service>.railway.internal:2112. We deliberately ignore Railway's
// $PORT injection so a Railway-injected public port doesn't move the
// listener away from the address Prometheus expects. Same fix as
// l2-block-time (see mobula-api commit 833026a719).

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Gas Estimation Accuracy Harness ===")
	fmt.Println("OpenChainBench - multi-chain gas oracle prediction error.")
	fmt.Println()

	chs := chains()
	for _, c := range chs {
		fmt.Printf("[%s] chainid=%d  rpc=%s  block~%ds  oracles=%v\n",
			c.Slug, c.ChainID, c.RealizedRPC, c.BlockTimeSec, c.SupportedSet)
		for _, o := range c.SupportedSet {
			ep := endpointForChain(o, c)
			fmt.Printf("  - %-22s every %s  %s\n", o, pollIntervals[o], ep.URL)
		}
	}
	fmt.Println()
	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Fan-out per chain: each chain gets its own buffer, head
	// tracker, realizer, and N oracle pollers (where N = len(c.SupportedSet)).
	// All run in parallel; metrics carry the `chain` label so they
	// never collide.
	for _, c := range chs {
		c := c
		buf := NewBuffer()
		var latestHead atomic.Uint64
		go runRealizerWithHead(ctx, buf, &latestHead, c)
		for _, o := range c.SupportedSet {
			o := o
			ep := endpointForChain(o, c)
			interval := pollIntervals[o]
			go runOraclePoller(ctx, o, ep, interval, buf, &latestHead, c)
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}

func runOraclePoller(ctx context.Context, o Oracle, ep OracleEndpoint, interval time.Duration, buf *Buffer, head *atomic.Uint64, chain Chain) {
	t := time.NewTicker(interval)
	defer t.Stop()

	tick := func() {
		pollCtx, cancel := context.WithTimeout(ctx, httpTimeout)
		defer cancel()
		res := pollOracle(pollCtx, o, ep)
		if res.Err != nil {
			classifyAndCount(o, res.Err, chain)
			gasOracleHealth.WithLabelValues(string(o), chain.Slug).Set(0)
			fmt.Printf("[%s/%s] err: %v\n", o, chain.Slug, res.Err)
			return
		}
		// Owlracle returns no explicit target — graft head+1.
		// If head is still unknown (startup race, realizer hasn't
		// run yet), skip buffering predictions for this cycle but
		// still emit the live-gauge so /metrics never goes blank.
		target := res.TargetBlock
		if target == 0 {
			h := head.Load()
			if h == 0 {
				for _, p := range res.Predictions {
					gasPredictedPriority.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Set(p.PriorityGwei)
				}
				gasOracleCallTotal.WithLabelValues(string(o), "ok", chain.Slug).Inc()
				gasOracleHealth.WithLabelValues(string(o), chain.Slug).Set(1)
				fmt.Printf("[%s/%s] head unknown yet, skipping buffer\n", o, chain.Slug)
				return
			}
			target = h + 1
		}
		now := time.Now()
		for _, p := range res.Predictions {
			p.CapturedAt = now
			buf.Add(target, p)
			gasPredictedPriority.WithLabelValues(string(p.Oracle), string(p.Tier), chain.Slug).Set(p.PriorityGwei)
		}
		if res.BaseGwei > 0 {
			gasPredictedBase.WithLabelValues(string(o), chain.Slug).Set(res.BaseGwei)
		}
		gasOracleCallTotal.WithLabelValues(string(o), "ok", chain.Slug).Inc()
		gasOracleHealth.WithLabelValues(string(o), chain.Slug).Set(1)
		fmt.Printf("[%s/%s] target=%d base=%.3f preds=%d\n", o, chain.Slug, target, res.BaseGwei, len(res.Predictions))
	}

	// Stagger startup so all pollers across chains don't fire at t=0.
	// Jitter folds in both the oracle name AND the chain slug so the
	// 3 Blocknative pollers (one per chain) hit at different offsets.
	time.Sleep(jitterFor(string(o) + ":" + chain.Slug))
	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

func classifyAndCount(o Oracle, err error, chain Chain) {
	msg := err.Error()
	result := "http_err"
	switch {
	case contains(msg, "throttled"), contains(msg, "429"):
		result = "throttled"
	case contains(msg, "parse"):
		result = "parse_err"
	case contains(msg, "context deadline"), contains(msg, "Timeout"):
		result = "timeout"
	}
	gasOracleCallTotal.WithLabelValues(string(o), result, chain.Slug).Inc()
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func jitterFor(s string) time.Duration {
	var sum int64
	for _, c := range s {
		sum = (sum*131 + int64(c)) % 100
	}
	if sum < 0 {
		sum = -sum
	}
	return time.Duration(sum) * 100 * time.Millisecond
}

// runRealizerWithHead is a thin wrapper around runRealizer that also
// publishes the latest observed head to the atomic counter shared
// with oracle pollers (used by Owlracle to graft a target block).
// One instance per chain.
func runRealizerWithHead(ctx context.Context, buf *Buffer, head *atomic.Uint64, chain Chain) {
	go func() {
		t := time.NewTicker(realizedPollInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				hctx, cancel := context.WithTimeout(ctx, httpTimeout)
				h, err := headBlock(hctx, chain.RealizedRPC)
				cancel()
				if err == nil {
					head.Store(h)
				}
			}
		}
	}()
	runRealizer(ctx, buf, chain)
}
