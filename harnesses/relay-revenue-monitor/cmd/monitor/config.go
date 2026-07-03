package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Config holds the runtime configuration.
type Config struct {
	// MobulaAPIKey is required: the /wallet/portfolio endpoint is the
	// only data source the harness uses, and it is auth-gated.
	MobulaAPIKey string

	// LogsToken gates the /logs?tail=N endpoint when set. Empty disables
	// the gate (dev convenience only; always set in production).
	LogsToken string

	// PollIntervalSec controls how often the poller wakes up to fetch the
	// portfolio. Default 300s = 5 min. Lower bound 60s because the
	// portfolio fetch itself takes 5 to 15 s for a multi-chain wallet of
	// this size and we don't want polls overlapping.
	PollIntervalSec int
}

func loadEnv() (*Config, error) {
	loadDotEnv()
	c := &Config{
		MobulaAPIKey:    strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		LogsToken:       strings.TrimSpace(os.Getenv("LOGS_TOKEN")),
		PollIntervalSec: 300,
	}
	if c.MobulaAPIKey == "" {
		return nil, fmt.Errorf("MOBULA_API_KEY is required (Mobula wallet portfolio endpoint is auth-gated)")
	}
	if v := os.Getenv("POLL_INTERVAL_SEC"); v != "" {
		var n int
		_, _ = fmt.Sscanf(v, "%d", &n)
		if n >= 60 {
			c.PollIntervalSec = n
		}
	}
	return c, nil
}

func loadDotEnv() {
	f, err := os.Open(".env")
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx < 0 {
			continue
		}
		k := strings.TrimSpace(line[:idx])
		v := strings.Trim(strings.TrimSpace(line[idx+1:]), `"'`)
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
}
