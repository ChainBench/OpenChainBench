package main

import (
	"os"
	"strings"
	"time"
)

type config struct {
	listen       string
	refInterval  time.Duration
	refTolerance time.Duration

	bitculatorKey  string
	mobulaKey      string
	coinstatsKey   string
	codexKey       string
	serializedKey  string
	coingeckoKey   string // optional demo key; keyless public API when empty
	coingeckoProxy string
}

func loadConfig() config {
	return config{
		listen:         envOr("LISTEN_ADDR", ":2112"),
		refInterval:    durOr("REFERENCE_INTERVAL", 5*time.Second),
		refTolerance:   durOr("REFERENCE_TOLERANCE", 6*time.Second),
		bitculatorKey:  strings.TrimSpace(os.Getenv("BITCULATOR_API_KEY")),
		mobulaKey:      strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		coinstatsKey:   strings.TrimSpace(os.Getenv("COINSTATS_API_KEY")),
		codexKey:       strings.TrimSpace(os.Getenv("CODEX_API_KEY")),
		serializedKey:  strings.TrimSpace(os.Getenv("SERIALIZED_API_KEY")),
		coingeckoKey:   strings.TrimSpace(os.Getenv("COINGECKO_DEMO_KEY")),
		coingeckoProxy: strings.TrimSpace(os.Getenv("COINGECKO_PROXY_URL")),
	}
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func durOr(k string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}
