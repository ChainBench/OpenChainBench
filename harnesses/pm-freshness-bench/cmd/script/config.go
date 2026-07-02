package main

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DefinedSessionCookie string
	MobulaApiKey         string
	LogsToken            string

	// Kalshi T0 polls /v1/social/trades (public, unauthenticated).
	// The default 5s cadence matches the upstream CloudFront max-age=10.
	KalshiPollIntervalSec int

	RefreshMarketsIntervalSec int
	BasketSize                int
}

func loadConfig() Config {
	return Config{
		DefinedSessionCookie:      strings.TrimSpace(os.Getenv("DEFINED_SESSION_COOKIE")),
		MobulaApiKey:              strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		LogsToken:                 strings.TrimSpace(os.Getenv("LOGS_TOKEN")),
		KalshiPollIntervalSec:     intEnv("KALSHI_POLL_INTERVAL_SEC", 5),
		RefreshMarketsIntervalSec: intEnv("REFRESH_MARKETS_INTERVAL_SEC", 300),
		BasketSize:                intEnv("BASKET_SIZE", 20),
	}
}

func intEnv(key string, dflt int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return dflt
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return dflt
	}
	return n
}
