package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime knobs read from env at boot. Keys are NEVER
// printed in full — only their length, so misconfigured deploys
// fail loudly without leaking material.
type Config struct {
	MobulaAPIKey  string
	MoralisAPIKey string
	HeliusAPIKey  string

	CheckDelay    time.Duration
	Workers       int
	QueueSize     int
	PromListen    string
	LogsToken     string
}

func loadConfig() *Config {
	c := &Config{
		MobulaAPIKey:  os.Getenv("MOBULA_API_KEY"),
		MoralisAPIKey: os.Getenv("MORALIS_API_KEY"),
		HeliusAPIKey:  os.Getenv("HELIUS_API_KEY"),
		CheckDelay:    parseDurationSec("WALLET_LABELS_CHECK_DELAY_SECONDS", 30),
		Workers:       parseInt("WALLET_LABELS_WORKERS", 8),
		QueueSize:     parseInt("WALLET_LABELS_QUEUE_SIZE", 2000),
		PromListen:    envDefault("PROM_LISTEN_ADDR", ":2112"),
		LogsToken:     os.Getenv("LOGS_TOKEN"),
	}

	fmt.Println("=== Wallet Labels Coverage Monitor ===")
	fmt.Printf("   Check delay: %v (override with WALLET_LABELS_CHECK_DELAY_SECONDS)\n", c.CheckDelay)
	fmt.Printf("   Workers: %d (override with WALLET_LABELS_WORKERS)\n", c.Workers)
	fmt.Printf("   Queue size: %d\n", c.QueueSize)
	fmt.Printf("   Prom listen: %s\n", c.PromListen)
	fmt.Printf("   Mobula key set: %v (len=%d)\n", c.MobulaAPIKey != "", len(c.MobulaAPIKey))
	fmt.Printf("   Moralis key set: %v (len=%d)\n", c.MoralisAPIKey != "", len(c.MoralisAPIKey))
	fmt.Printf("   Helius key set: %v (len=%d)\n", c.HeliusAPIKey != "", len(c.HeliusAPIKey))
	fmt.Println()

	return c
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseDurationSec(key string, def int) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return time.Duration(def) * time.Second
}

func parseInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
