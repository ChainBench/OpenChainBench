package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/solana-exec/internal/platform"
	"github.com/ChainBench/OpenChainBench/harnesses/solana-exec/internal/store"
)

func main() {
	ctx := context.Background()

	db, err := store.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("materializer: %v", err)
	}
	defer db.Close()

	for {
		for plt := range platform.FeeAccounts {
			if err := db.Materialize(ctx, plt); err != nil {
				log.Printf("materializer: %s: %v", plt, err)
			} else {
				log.Printf("materializer: %s: done", plt)
			}
		}
		if err := db.PurgeCUSamples(ctx); err != nil {
			log.Printf("materializer: purge cu samples: %v", err)
		}
		if err := db.PurgeEvents(ctx); err != nil {
			log.Printf("materializer: purge events: %v", err)
		}
		time.Sleep(5 * time.Minute)
	}
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing env: %s", key)
	}
	return v
}
