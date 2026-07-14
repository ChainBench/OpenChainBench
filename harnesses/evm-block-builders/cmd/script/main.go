package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Bench 085 "evm-block-builders": who builds Ethereum, plus L2
// soft-confirmation lag.
//
// Four independent measurement loops share one process:
//   1. builders.go  - ETH head poll, extraData → builder attribution
//   2. relays.go    - MEV-Boost relay bidtrace pollers (cross-check)
//   3. arb_feed.go  - Arbitrum sequencer feed → RPC visibility lag
//   4. base_flashblocks.go - Base flashblock cadence + → RPC lag
//
// Metrics server listens on :2112 - OCB convention; $PORT is ignored
// so Prometheus can scrape the expected address.

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== EVM Block Builders Harness (bench 085) ===")
	fmt.Println("OpenChainBench: builder market share via extraData + L2 soft-confirmation lag.")
	fmt.Println()
	fmt.Printf("ETH RPC:          %s (poll %s)\n", ethRPCURL(), ethPollInterval)
	fmt.Printf("Relays:           %d bidtrace APIs (poll %s)\n", len(relays()), relayPollInterval)
	fmt.Printf("Arb feed:         %s\n", arbFeedURL())
	fmt.Printf("Arb RPC:          %s (poll %s)\n", arbRPCURL(), l2HeadPollInterval)
	fmt.Printf("Base flashblocks: %s\n", baseFlashblocksURL())
	fmt.Printf("Base RPC:         %s (poll %s)\n", baseRPCURL(), l2HeadPollInterval)
	fmt.Println()
	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	go func() {
		if err := StartMetricsServer(listenAddr()); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			// Give the loghub forwarding goroutine a beat to flush the
			// fatal line to the real stdout before we exit.
			time.Sleep(200 * time.Millisecond)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialise health gauges to 0; each loop flips its own to 1.
	ethPollHealth.Set(0)
	arbFeedHealth.Set(0)
	baseFeedHealth.Set(0)
	for _, r := range relays() {
		relayHealth.WithLabelValues(r.Slug).Set(0)
	}

	go runBuilderPoll(ctx)
	runRelayPolls(ctx)

	arbState := newArbFeedState()
	go runArbFeed(ctx, arbState)
	go runArbHeadPoller(ctx, arbState)

	baseState := newBaseFeedState()
	go runBaseFlashblocks(ctx, baseState)
	go runBaseHeadPoller(ctx, baseState)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}
