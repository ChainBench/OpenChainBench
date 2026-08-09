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

	for {
		if err := runCollector(ctx, db, dydx, "dydx-v4:dydx-chain"); err != nil {
			log.Printf("dydx collector error: %v", err)
		}
		if err := runCollector(ctx, db, hl, "hyperliquid:hypercore"); err != nil {
			log.Printf("hyperliquid collector error: %v", err)
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
