package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Config holds runtime configuration for the token-quote-coverage harness.
type Config struct {
	MonitorRegion string
	LogsToken     string
	MobulaAPIKey  string
	OneInchAPIKey string
	OKXDEXAPIKey  string // optional
}

func loadEnv() (*Config, error) {
	loadDotEnv()

	c := &Config{
		MonitorRegion: strings.TrimSpace(os.Getenv("MONITOR_REGION")),
		LogsToken:     strings.TrimSpace(os.Getenv("LOGS_TOKEN")),
		MobulaAPIKey:  strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		OneInchAPIKey: strings.TrimSpace(os.Getenv("ONEINCH_API_KEY")),
		OKXDEXAPIKey:  strings.TrimSpace(os.Getenv("OKX_DEX_API_KEY")),
	}
	if c.MonitorRegion == "" {
		c.MonitorRegion = "eu-west"
	}
	if c.MobulaAPIKey == "" {
		return nil, fmt.Errorf("MOBULA_API_KEY is required")
	}
	if c.OneInchAPIKey == "" {
		return nil, fmt.Errorf("ONEINCH_API_KEY is required")
	}
	return c, nil
}

// loadDotEnv loads a .env file from cwd if present (local dev convenience).
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
