package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds runtime knobs. Set via env vars on the deploy target.
type Config struct {
	// ProbeInterval is how often a full probe cycle runs across the
	// provider cohort. Default is 24h and this is DELIBERATE: every
	// probe call spends paid API credits on four commercial portfolio
	// APIs, and chain-coverage numbers move on a weeks cadence, not
	// minutes. One cycle is ~6 upstream calls total, so the default
	// budget is ~6 calls/day. Override via PROBE_INTERVAL_HOURS, but
	// never ship a lower default.
	ProbeInterval time.Duration
}

func loadConfig() *Config {
	c := &Config{
		ProbeInterval: 24 * time.Hour,
	}

	if v := os.Getenv("PROBE_INTERVAL_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.ProbeInterval = time.Duration(n) * time.Hour
		}
	}

	keysPresent := 0
	for _, p := range Registry {
		if strings.TrimSpace(os.Getenv(p.KeyEnv)) != "" {
			keysPresent++
		}
	}

	fmt.Printf("Config: providers=%d, keys_present=%d, probe_every=%v\n",
		len(Registry), keysPresent, c.ProbeInterval)
	return c
}

// envDefault returns the trimmed env var value, or def when unset/empty.
// Same helper shape as rpc-capabilities so base URLs can be swapped
// without a rebuild (useful when a vendor moves its API host).
func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
