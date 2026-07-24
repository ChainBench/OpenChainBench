package main

import (
	"os"
	"strings"
	"time"
)

// Poll cadences. On-chain reads run every pollInterval; the rolling
// 30d/7d windows are recomputed at windowRecomputeInterval (heavier
// query, values move slowly enough that once an hour is plenty).
const (
	pollInterval             = 60 * time.Second
	windowRecomputeInterval  = time.Hour
	promisedReloadInterval   = 60 * time.Second
	httpTimeout              = 30 * time.Second
)

// Rolling window sizes for delivered-yield computation.
const (
	Window7d       = 7 * 24 * time.Hour
	Window30d      = 30 * 24 * time.Hour
	WindowLifetime = time.Duration(0) // sentinel: from token inception
)

// rpcURL returns the Ethereum mainnet RPC endpoint used by every
// probe. All five V1 tokens live on Ethereum; V2 will introduce
// per-chain endpoints for BUIDL/USDY multi-chain support.
//
// Default is dRPC because the harness needs archive access (eth_call
// at t-30d block). publicnode.com — the usual OCB default — rejects
// archive requests without an account. dRPC's free tier supports
// archive reads at least back to 30-day depth.
func rpcURL() string {
	if v := strings.TrimSpace(os.Getenv("RPC_ETHEREUM")); v != "" {
		return v
	}
	return "https://eth.drpc.org"
}

func listenAddr() string {
	if v := strings.TrimSpace(os.Getenv("LISTEN_ADDR")); v != "" {
		return v
	}
	return ":2112"
}

// promisedYieldsPath resolves the config file location. Defaults to
// /app/promised-yields.yml (Docker image layout); local development
// can override via PROMISED_YIELDS_PATH.
func promisedYieldsPath() string {
	if v := strings.TrimSpace(os.Getenv("PROMISED_YIELDS_PATH")); v != "" {
		return v
	}
	return "/app/promised-yields.yml"
}
