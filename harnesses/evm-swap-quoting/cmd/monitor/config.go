package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Config holds the runtime configuration. Mirrors solana-quote-latency.
type Config struct {
	MonitorRegion string
	LogsToken     string

	// API keys. Only Mobula is required (its endpoint is auth-gated).
	// The other providers in V1 (KyberSwap, Bebop, LI.FI, OpenOcean) are
	// no-key. 1inch and 0x will require keys when added.
	MobulaAPIKey    string
	OneInchAPIKey   string // optional, future
	ZeroExAPIKey    string // optional, future
	OdosAPIKey      string // optional, future
}

func loadEnv() (*Config, error) {
	loadDotEnv() // best-effort, ignore errors

	c := &Config{
		MonitorRegion: strings.TrimSpace(os.Getenv("MONITOR_REGION")),
		LogsToken:     strings.TrimSpace(os.Getenv("LOGS_TOKEN")),
		MobulaAPIKey:  strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		OneInchAPIKey: strings.TrimSpace(os.Getenv("ONEINCH_API_KEY")),
		ZeroExAPIKey:  strings.TrimSpace(os.Getenv("ZEROX_API_KEY")),
		OdosAPIKey:    strings.TrimSpace(os.Getenv("ODOS_API_KEY")),
	}
	if c.MonitorRegion == "" {
		c.MonitorRegion = "eu-west"
	}
	if c.MobulaAPIKey == "" {
		return nil, fmt.Errorf("MOBULA_API_KEY is required (Mobula swap quoting endpoint is auth-gated)")
	}
	return c, nil
}

// loadDotEnv loads a .env file from the current working dir if present.
// Local dev convenience; production env comes from Railway.
func loadDotEnv() {
	f, err := os.Open(".env")
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx < 0 {
			continue
		}
		k := strings.TrimSpace(line[:idx])
		v := strings.TrimSpace(line[idx+1:])
		v = strings.Trim(v, `"'`)
		if os.Getenv(k) == "" {
			os.Setenv(k, v)
		}
	}
}
