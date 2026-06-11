package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Stablecoin Peg Deviation Harness ===")
	fmt.Println("OpenChainBench - live peg deviation vs $1.00 across CEX + on-chain venues.")
	fmt.Println()

	srcs := sources()
	for _, s := range srcs {
		fmt.Printf("  - %-6s @ %-18s (%s, quote=%s, liq=$%dM)\n",
			s.Stable, s.Venue, s.Pair, s.Quote, int(s.Liquidity/1e6))
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

	agg := NewAggregator()
	go agg.FlushMinuteLoop()

	for _, s := range srcs {
		s := s
		interval := cexPollInterval
		if s.Venue == "curve_3pool" || s.Venue == "curve_3pool_rev" {
			interval = curvePollInterval
		}
		go runSourceLoop(ctx, s, interval, agg)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	rcvd := <-sig
	fmt.Printf("\n[shutdown] received %v\n", rcvd)
	cancel()
}

func runSourceLoop(ctx context.Context, s Source, interval time.Duration, agg *Aggregator) {
	t := time.NewTicker(interval)
	defer t.Stop()

	tick := func() {
		pollCtx, cancel := context.WithTimeout(ctx, httpTimeout)
		defer cancel()
		price, err := poll(pollCtx, s)
		if err != nil {
			classifyAndCount(s, err)
			pegSourceHealth.WithLabelValues(s.stable(), s.venue()).Set(0)
			fmt.Printf("[%s/%s] err: %v\n", s.Stable, s.Venue, err)
			return
		}
		now := time.Now()
		agg.Ingest(sample{
			stable:       s.Stable,
			venue:        s.Venue,
			quote:        s.Quote,
			price:        price,
			liquidity:    s.Liquidity,
			receivedAt:   now,
			minuteBucket: now.Truncate(minuteBucketSize),
		})
		dev := (price - 1.0) * 10000
		fmt.Printf("[%s/%s] %.6f dev=%+.2fbps\n", s.Stable, s.Venue, price, dev)
	}

	// Stagger startup deterministically.
	time.Sleep(jitterFor(s.Stable + s.Venue))
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

// Convenience helpers so the call sites stay readable.
func (s Source) stable() string { return s.Stable }
func (s Source) venue() string  { return s.Venue }

func classifyAndCount(s Source, err error) {
	msg := err.Error()
	result := "http_err"
	switch {
	case contains(msg, "parse"), contains(msg, "invalid"):
		result = "parse_err"
	case contains(msg, "deadline"), contains(msg, "Timeout"):
		result = "timeout"
	case contains(msg, "stale"):
		result = "stale"
	}
	pegSourceCallTotal.WithLabelValues(s.Stable, s.Venue, result).Inc()
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
	return time.Duration(sum) * 50 * time.Millisecond
}
