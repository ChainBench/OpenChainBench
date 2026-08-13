package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/evm-exec/internal/store"
)

func main() {
	ctx := context.Background()
	db, err := store.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("materializer: %v", err)
	}
	defer db.Close()

	for {
		if err := db.Materialize(ctx); err != nil {
			log.Printf("materializer: %v", err)
		} else {
			log.Printf("materializer: done")
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
