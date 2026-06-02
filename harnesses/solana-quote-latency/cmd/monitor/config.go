package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

type Config struct {
	MobulaAPIKey  string
	DFlowAPIKey   string
	JupiterAPIKey string
	MonitorRegion string
	LogsToken     string
}

func loadEnv() (*Config, error) {
	cfg := &Config{
		MobulaAPIKey:  strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		DFlowAPIKey:   strings.TrimSpace(os.Getenv("DFLOW_API_KEY")),
		JupiterAPIKey: strings.TrimSpace(os.Getenv("JUPITER_API_KEY")),
		MonitorRegion: strings.TrimSpace(os.Getenv("MONITOR_REGION")),
		LogsToken:     strings.TrimSpace(os.Getenv("LOGS_TOKEN")),
	}

	if cfg.MonitorRegion == "" {
		cfg.MonitorRegion = "unknown"
	}

	// If any env var is already populated assume we're in production / Railway
	// and skip the .env file lookup.
	if cfg.MobulaAPIKey != "" || cfg.DFlowAPIKey != "" || cfg.JupiterAPIKey != "" || cfg.LogsToken != "" {
		return cfg, nil
	}

	file, err := os.Open(".env")
	if err != nil {
		return cfg, nil
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
		case "MOBULA_API_KEY":
			if cfg.MobulaAPIKey == "" {
				cfg.MobulaAPIKey = value
			}
		case "DFLOW_API_KEY":
			if cfg.DFlowAPIKey == "" {
				cfg.DFlowAPIKey = value
			}
		case "JUPITER_API_KEY":
			if cfg.JupiterAPIKey == "" {
				cfg.JupiterAPIKey = value
			}
		case "MONITOR_REGION":
			if cfg.MonitorRegion == "" || cfg.MonitorRegion == "unknown" {
				cfg.MonitorRegion = value
			}
		case "LOGS_TOKEN":
			if cfg.LogsToken == "" {
				cfg.LogsToken = value
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading .env file: %w", err)
	}
	return cfg, nil
}
