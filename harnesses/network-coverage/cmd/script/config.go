package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	MobulaAPIKey       string
	CodexAPIKey        string // official Codex Bearer (preferred — no mint, no proxy)
	CodexSessionCookie string // fallback path: mint JWT from Defined.fi cookie
	DefinedTokenURL    string // optional: pre-minted JWT sidecar
	CoinStatsAPIKey    string
	SimDuneAPIKey      string // optional — Sim's public endpoint works keyless, but a key avoids rate limits
	HTTPProxy          string
	RefreshInterval    time.Duration
	IncludeTestnets    bool
}

func loadConfig() *Config {
	c := &Config{
		MobulaAPIKey:       os.Getenv("MOBULA_API_KEY"),
		CodexAPIKey:        os.Getenv("CODEX_API_KEY"),
		CodexSessionCookie: os.Getenv("DEFINED_SESSION_COOKIE"),
		DefinedTokenURL:    os.Getenv("DEFINED_TOKEN_SERVICE_URL"),
		CoinStatsAPIKey:    os.Getenv("COINSTATS_API_KEY"),
		SimDuneAPIKey:      os.Getenv("SIM_DUNE_API_KEY"),
		HTTPProxy:          os.Getenv("HTTP_PROXY"),
		RefreshInterval:    6 * time.Hour,
		IncludeTestnets:    false,
	}

	if v := os.Getenv("REFRESH_INTERVAL_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.RefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if os.Getenv("INCLUDE_TESTNETS") == "true" {
		c.IncludeTestnets = true
	}

	codexAuth := "none"
	if c.CodexAPIKey != "" {
		codexAuth = "api_key"
	} else if c.CodexSessionCookie != "" {
		codexAuth = "cookie+mint"
	}
	fmt.Printf("Config: refresh=%v, testnets=%v, mobula_key=%v, codex=%s, coinstats_key=%v, sim_dune_key=%v\n",
		c.RefreshInterval, c.IncludeTestnets, c.MobulaAPIKey != "", codexAuth,
		c.CoinStatsAPIKey != "", c.SimDuneAPIKey != "")
	return c
}
