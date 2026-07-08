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
	// ProbeInterval is how often a full probe cycle runs. Default is
	// 24h: every cohort surface is free, but a full cycle is ~600
	// upstream calls (dominated by the Blockscout registry sweep) and
	// chain-coverage numbers move on a weeks cadence.
	ProbeInterval time.Duration
}

func loadConfig() *Config {
	c := &Config{ProbeInterval: 24 * time.Hour}

	if v := os.Getenv("PROBE_INTERVAL_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.ProbeInterval = time.Duration(n) * time.Hour
		}
	}
	if v := os.Getenv("FRESH_WINDOW_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			freshWindow = time.Duration(n) * time.Minute
		}
	}

	fmt.Printf("Config: providers=%d, probe_every=%v, fresh_window=%v\n",
		len(Registry), c.ProbeInterval, freshWindow)
	return c
}

// envDefault returns the trimmed env var value, or def when unset.
func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
