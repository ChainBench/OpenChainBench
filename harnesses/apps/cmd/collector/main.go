package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/collect/rest"
	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/ledger"
	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

func main() {
	ctx := context.Background()

	db, err := ledger.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("collector: %v", err)
	}
	defer db.Close()

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		http.ListenAndServe(":2112", nil)
	}()

	dydx := rest.NewDyDX()
	hl := rest.NewHyperliquid()
	gmxArb := rest.NewGMXv2Arbitrum()
	gmxAvax := rest.NewGMXv2Avalanche()

	gainsWS := rest.NewGainsTradeWS()

	// WebSocket collector: real-time per-trade fees from gTrade first-party backend.
	// Runs as a persistent goroutine; reconnects on any error.
	go func() {
		for {
			out := make(chan spec.FeeEvent, 500)
			after := time.Now().UTC().Truncate(24 * time.Hour)
			go func() {
				defer close(out)
				if err := gainsWS.Stream(ctx, "gains-trade:arbitrum", after, out); err != nil && ctx.Err() == nil {
					log.Printf("gains-trade WS: %v", err)
				}
			}()
			for e := range out {
				if err := db.UpsertEvents(ctx, []spec.FeeEvent{e}); err != nil {
					log.Printf("gains-trade WS upsert: %v", err)
				}
			}
			if ctx.Err() != nil {
				return
			}
			time.Sleep(10 * time.Second)
		}
	}()

	for {
		if err := runCollector(ctx, db, dydx, "dydx-v4:dydx-chain"); err != nil {
			log.Printf("dydx collector error: %v", err)
		}
		if err := runCollector(ctx, db, hl, "hyperliquid:hypercore"); err != nil {
			log.Printf("hyperliquid collector error: %v", err)
		}
		if err := runCollector(ctx, db, gmxArb, "gmx-v2:arbitrum"); err != nil {
			log.Printf("gmx-v2:arbitrum collector error: %v", err)
		}
		if err := runCollector(ctx, db, gmxAvax, "gmx-v2:avalanche"); err != nil {
			log.Printf("gmx-v2:avalanche collector error: %v", err)
		}
		time.Sleep(60 * time.Second)
	}
}

func runCollector(ctx context.Context, db *ledger.DB, col spec.Collector, deploymentID string) error {
	from, err := db.GetCursor(ctx, deploymentID)
	if err != nil {
		return err
	}

	to := spec.Cursor{
		Height:    ^uint64(0),
		Ts:        time.Now(),
		Finalized: true,
	}

	out := make(chan spec.FeeEvent, 1000)
	collectErr := make(chan error, 1)

	go func() {
		defer close(out)
		newCursor, err := col.Collect(ctx, deploymentID, from, to, out)
		if err != nil {
			collectErr <- err
			return
		}
		collectErr <- db.SaveCursor(ctx, deploymentID, newCursor)
	}()

	var batch []spec.FeeEvent
	for e := range out {
		batch = append(batch, e)
		if len(batch) >= 500 {
			if err := db.UpsertEvents(ctx, batch); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
	if len(batch) > 0 {
		if err := db.UpsertEvents(ctx, batch); err != nil {
			return err
		}
	}

	return <-collectErr
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing required env: %s", key)
	}
	return v
}
