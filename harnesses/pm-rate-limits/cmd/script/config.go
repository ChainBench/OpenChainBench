package main

import (
	"fmt"
	"os"
	"strings"
)

// userAgent identifies every probe per the OCB methodology page. Venues can
// contact us or block the UA selectively instead of banning a bare Go client.
const userAgent = "OpenChainBench/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)"

// Config groups the env-driven knobs the harness needs at startup. Direct
// venue probes don't need any of these; the aggregator goroutines stay
// idle when the corresponding key is empty.
type Config struct {
	MobulaAPIKey         string // Authorization: <key> on api.mobula.io
	PredexonAPIKey       string // x-api-key on api.predexon.com
	DefinedSessionCookie string // 7-day cookie used to mint Codex JWT
	KalshiAPIKeyID       string // KALSHI-ACCESS-KEY header for WS auth
	KalshiPrivateKeyPEM  string // RSA private key PEM for WS signature
}

func loadConfig() Config {
	cfg := Config{
		MobulaAPIKey:         strings.TrimSpace(os.Getenv("MOBULA_API_KEY")),
		PredexonAPIKey:       strings.TrimSpace(os.Getenv("PREDEXON_API_KEY")),
		DefinedSessionCookie: strings.TrimSpace(os.Getenv("DEFINED_SESSION_COOKIE")),
		KalshiAPIKeyID:       strings.TrimSpace(os.Getenv("KALSHI_API_KEY_ID")),
		KalshiPrivateKeyPEM:  strings.TrimSpace(os.Getenv("KALSHI_PRIVATE_KEY_PEM")),
	}
	fmt.Printf("[providers] mobula=%v predexon=%v codex=%v kalshi_ws=%v\n",
		cfg.MobulaAPIKey != "", cfg.PredexonAPIKey != "", cfg.DefinedSessionCookie != "",
		cfg.KalshiAPIKeyID != "" && cfg.KalshiPrivateKeyPEM != "")
	return cfg
}

func envDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// currentRegion is stamped onto every Prometheus label as `region=`.
// Resolution order matches rpc-capabilities:
//  1. $REGION (explicit override, one Railway service per region)
//  2. $RAILWAY_REPLICA_REGION (Railway "Add Region" replicas)
//  3. "eu-west"
var currentRegion = loadRegion()

func loadRegion() string {
	if r := strings.TrimSpace(os.Getenv("REGION")); r != "" {
		return r
	}
	if r := normalizeRailwayRegion(os.Getenv("RAILWAY_REPLICA_REGION")); r != "" {
		return r
	}
	return "eu-west"
}

// Railway exposes replica region as raw GCP-style slugs like "us-east4-eqdc4a".
// Map them down to the canonical 3-region set (us-east / eu-west / sgp) so the
// Prom label space stays small. Unknown values pass through so a new Railway
// region surfaces in the metric instead of silently bucketing as eu-west.
func normalizeRailwayRegion(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return ""
	}
	switch {
	case strings.HasPrefix(raw, "us-"), strings.HasPrefix(raw, "northamerica"):
		return "us-east"
	case strings.HasPrefix(raw, "europe"), strings.HasPrefix(raw, "eu-"):
		return "eu-west"
	case strings.HasPrefix(raw, "asia"), strings.HasPrefix(raw, "ap-"):
		return "sgp"
	default:
		return raw
	}
}
