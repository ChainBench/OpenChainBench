package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	installLogCapture()
	log.SetFlags(0)
	log.Printf("[pm-resolution-delay] starting, adapters=%v oo=%v rpcs=%d backfill=%dh poll=%s",
		adapterAddresses, ooAddresses, len(rpcURLs), backfillHours, pollInterval)

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			log.Printf("[pm-resolution-delay] metrics server died: %v", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	gamma := newGammaStore()
	rpc := newRPCClient(rpcURLs)
	eng := newEngine(rpc, gamma)

	go healthLoop()
	go gamma.pendingLoop(ctx)
	go func() {
		// Category map first, then the chain engine: backfilled resolutions
		// join against Gamma tags instead of falling back to keywords.
		gamma.crawlCategories(ctx, 20)
		go gamma.categoryLoop(ctx)
		eng.run(ctx)
	}()

	<-ctx.Done()
	log.Printf("[pm-resolution-delay] shutting down")
}
