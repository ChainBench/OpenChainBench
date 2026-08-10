package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/invariant"
	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/ledger"
)

func main() {
	ctx := context.Background()

	db, err := ledger.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("materializer: %v", err)
	}
	defer db.Close()

	checker := invariant.New(db.Pool())

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		http.ListenAndServe(":2112", nil)
	}()

	for {
		if err := runMaterialize(ctx, db, checker); err != nil {
			log.Printf("materializer error: %v", err)
		}
		time.Sleep(5 * time.Minute)
	}
}

func runMaterialize(ctx context.Context, db *ledger.DB, checker *invariant.Checker) error {
	const mv = 1
	deployments := []string{
		"dydx-v4:dydx-chain",
		"hyperliquid:hypercore",
		"gmx-v2:arbitrum",
		"gmx-v2:avalanche",
		"gains-trade:arbitrum",
		"drift:solana",
		"jupiter-perps:solana",
		"vertex:arbitrum",
	}

	for _, dep := range deployments {
		if err := db.Materialize(ctx, dep, mv); err != nil {
			return err
		}
		if err := checker.CheckAll(ctx, dep, mv); err != nil {
			log.Printf("INVARIANT FAILED %s: %v — quarantining", dep, err)
			if qErr := db.Quarantine(ctx, dep, err.Error()); qErr != nil {
				log.Printf("quarantine write failed: %v", qErr)
			}
			continue
		}
		if err := db.RefreshMaterializedView(ctx); err != nil {
			return err
		}
	}
	return nil
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing required env: %s", key)
	}
	return v
}
