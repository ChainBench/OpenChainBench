package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

type Config struct {
	CoinGeckoAPIKey      string
	MobulaAPIKey         string
	DefinedSessionCookie string
	MonitorRegion        string // Deployment region: us-west, us-east, singapore, etc.
	MobulaWSURL          string // Mobula fast-trade WebSocket endpoint (allows staging to use EU-specific cluster)
}

func loadEnv() (*Config, error) {
	config := &Config{}

	// First, try to load from environment variables (for production/Railway)
	config.CoinGeckoAPIKey = strings.TrimSpace(os.Getenv("COINGECKO_API_KEY"))
	config.MobulaAPIKey = strings.TrimSpace(os.Getenv("MOBULA_API_KEY"))
	config.DefinedSessionCookie = strings.TrimSpace(os.Getenv("DEFINED_SESSION_COOKIE"))
	config.MonitorRegion = strings.TrimSpace(os.Getenv("MONITOR_REGION"))
	config.MobulaWSURL = strings.TrimSpace(os.Getenv("MOBULA_WS_URL"))

	// Default to "unknown" if not set
	if config.MonitorRegion == "" {
		config.MonitorRegion = "unknown"
	}

	// Default Mobula WS endpoint (global). Staging can override to wss://api-prod-eu.mobula.io
	if config.MobulaWSURL == "" {
		config.MobulaWSURL = "wss://api.mobula.io"
	}

	// If all env vars are set, return early (production mode)
	if config.CoinGeckoAPIKey != "" || config.MobulaAPIKey != "" || config.DefinedSessionCookie != "" {
		return config, nil
	}

	// Otherwise, try to load from .env file (for local development)
	file, err := os.Open(".env")
	if err != nil {
		// If no .env file and no env vars, that's OK - services will just be skipped
		return config, nil
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key, value := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		switch key {
		case "COINGECKO_API_KEY":
			if config.CoinGeckoAPIKey == "" {
				config.CoinGeckoAPIKey = value
			}
		case "MOBULA_API_KEY":
			if config.MobulaAPIKey == "" {
				config.MobulaAPIKey = value
			}
		case "DEFINED_SESSION_COOKIE":
			if config.DefinedSessionCookie == "" {
				config.DefinedSessionCookie = value
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading .env file: %w", err)
	}

	return config, nil
}
