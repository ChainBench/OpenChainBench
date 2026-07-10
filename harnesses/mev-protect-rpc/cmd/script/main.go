package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// MEV-protect wallet RPC bench (074). Probes the JSON-RPC method set
// wallets actually call against public MEV-protection gateways
// (Flashbots Protect, MEV Blocker, Blink). No transactions are sent;
// the write path (inclusion, refunds, sandwich protection) is out of
// scope by design and the spec discloses it.
//
// Metrics on :2112, the OCB harness convention.

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
		return ""
	}
}

func main() {
	fmt.Printf("[mev-protect] starting, region=%s, %d providers\n", currentRegion, len(providers))

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "2112"
	}
	go func() {
		if err := http.ListenAndServe(":"+port, mux); err != nil {
			fmt.Printf("[mev-protect] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	go runProbeLoop(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	cancel()
	fmt.Println("[mev-protect] shutting down")
}
