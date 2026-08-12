// solana-dex-volume -- Bench 205
//
// Polls the DeFiLlama DEX API every 30 minutes for each tracked platform
// and exposes per-platform 24h volume and fees as Prometheus gauges.
//
// No API key required. Endpoint: https://api.llama.fi/summary/dexs/{slug}
//
// Metrics on :2112/metrics:
//
//	defillama_dex_volume_24h_usd{platform}
//	defillama_dex_fees_24h_usd{platform}
//	defillama_dex_health{platform}
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	pollInterval = 30 * time.Minute
	baseURL      = "https://api.llama.fi"
)

var platforms = []struct {
	slug  string
	label string
}{
	{"pumpswap", "pumpswap"},
	{"pump.fun", "pump-fun"},
	{"gmgn", "gmgn"},
	{"axiom", "axiom"},
	{"fomo-wallet", "fomo"},
	{"trojan", "trojan"},
	{"photon", "photon"},
}

var (
	volume24h = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_volume_24h_usd",
		Help: "24h DEX trading volume in USD from DeFiLlama",
	}, []string{"platform"})

	fees24h = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_fees_24h_usd",
		Help: "24h DEX protocol fees in USD from DeFiLlama",
	}, []string{"platform"})

	health = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_health",
		Help: "1 if last DeFiLlama fetch succeeded, 0 otherwise",
	}, []string{"platform"})
)

type llamaResponse struct {
	Total24h float64 `json:"total24h"`
}

func fetch(endpoint, slug string) (float64, error) {
	url := fmt.Sprintf("%s/summary/%s/%s", baseURL, endpoint, slug)
	resp, err := http.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var r llamaResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return 0, err
	}
	return r.Total24h, nil
}

func runOnce() {
	for _, p := range platforms {
		vol, err := fetch("dexs", p.slug)
		if err != nil {
			fmt.Printf("[poll] volume %s: %v\n", p.slug, err)
			health.WithLabelValues(p.label).Set(0)
			continue
		}

		fees, err := fetch("fees", p.slug)
		if err != nil {
			fmt.Printf("[poll] fees %s: %v (volume ok)\n", p.slug, err)
			fees = 0
		}

		volume24h.WithLabelValues(p.label).Set(vol)
		fees24h.WithLabelValues(p.label).Set(fees)
		health.WithLabelValues(p.label).Set(1)
		fmt.Printf("[poll] %s: vol=$%.0f fees=$%.0f\n", p.label, vol, fees)
	}
}

func main() {
	fmt.Println("=== solana-dex-volume harness (Bench 205) ===")

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
		fmt.Println("[srv] metrics on :2112")
		if err := http.ListenAndServe(":2112", nil); err != nil {
			fmt.Fprintf(os.Stderr, "[fatal] %v\n", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	runOnce()

	tick := time.NewTicker(pollInterval)
	defer tick.Stop()

	for {
		select {
		case <-sig:
			return
		case <-tick.C:
			runOnce()
		}
	}
}
