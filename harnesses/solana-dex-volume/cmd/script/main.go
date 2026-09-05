// solana-dex-volume -- Bench 205
//
// Polls the DeFiLlama DEX API every 30 minutes for each tracked platform
// and exposes per-platform 24h/7d volume and protocol revenue as Prometheus gauges.
//
// No API key required. Primary source: https://api.llama.fi/overview/dexs/solana
// (chain-scoped, so multichain platforms like GMGN report their SOLANA
// volume only, keeping the bench apples-to-apples). Falls back to the
// per-protocol summary endpoint for any platform missing from the
// overview.
//
// Metrics on :2112/metrics:
//
//	defillama_dex_volume_24h_usd{platform}
//	defillama_dex_volume_7d_usd{platform}
//	defillama_dex_fees_24h_usd{platform}   (protocol revenue, ?dataType=dailyRevenue)
//	defillama_dex_fees_7d_usd{platform}
//	defillama_dex_take_rate{platform}       (fees24h / volume24h)
//	defillama_dex_health{platform}
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
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
	slug  string   // per-protocol summary slug (fallback path)
	label string   // prometheus label
	names []string // lowercase name candidates in the chain overview
}{
	{"pump.fun", "pump-fun", []string{"pump.fun"}},
	{"gmgn", "gmgn", []string{"gmgn"}},
	{"axiom", "axiom", []string{"axiom"}},
	{"fomo-wallet", "fomo", []string{"fomo", "fomo-wallet"}},
	{"trojan", "trojan", []string{"trojan"}},
	{"photon", "photon", []string{"photon"}},
	{"bullx", "bullx", []string{"bullx"}},
}

var (
	volume24h = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_volume_24h_usd",
		Help: "24h DEX trading volume in USD from DeFiLlama",
	}, []string{"platform"})

	volume7d = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_volume_7d_usd",
		Help: "7-day DEX trading volume in USD from DeFiLlama",
	}, []string{"platform"})

	fees24h = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_fees_24h_usd",
		Help: "24h protocol revenue in USD from DeFiLlama (dailyRevenue dataType)",
	}, []string{"platform"})

	fees7d = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_fees_7d_usd",
		Help: "7-day protocol revenue in USD from DeFiLlama (dailyRevenue dataType)",
	}, []string{"platform"})

	takeRate = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_take_rate",
		Help: "Protocol revenue as fraction of trading volume (fees24h / volume24h)",
	}, []string{"platform"})

	health = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "defillama_dex_health",
		Help: "1 if last DeFiLlama fetch succeeded, 0 otherwise",
	}, []string{"platform"})
)

type llamaResponse struct {
	Total24h float64 `json:"total24h"`
	Total7d  float64 `json:"total7d"`
}

type overviewResponse struct {
	Protocols []struct {
		Name        string  `json:"name"`
		DisplayName string  `json:"displayName"`
		Module      string  `json:"module"`
		Total24h    float64 `json:"total24h"`
		Total7d     float64 `json:"total7d"`
	} `json:"protocols"`
}

// fetchOverview returns Solana-scoped per-protocol totals indexed by
// lowercased name/displayName/module. One call covers every platform.
func fetchOverview(endpoint, query string) (map[string]llamaResponse, error) {
	url := fmt.Sprintf("%s/overview/%s/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true", baseURL, endpoint)
	if query != "" {
		url += "&" + query
	}
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var r overviewResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	out := map[string]llamaResponse{}
	for _, p := range r.Protocols {
		v := llamaResponse{Total24h: p.Total24h, Total7d: p.Total7d}
		for _, k := range []string{p.Name, p.DisplayName, p.Module} {
			if k != "" {
				out[strings.ToLower(k)] = v
			}
		}
	}
	return out, nil
}

func lookup(ov map[string]llamaResponse, names []string) (llamaResponse, bool) {
	for _, n := range names {
		if v, ok := ov[n]; ok {
			return v, true
		}
	}
	return llamaResponse{}, false
}

func fetch(endpoint, slug, query string) (llamaResponse, error) {
	url := fmt.Sprintf("%s/summary/%s/%s", baseURL, endpoint, slug)
	if query != "" {
		url += "?" + query
	}
	resp, err := http.Get(url)
	if err != nil {
		return llamaResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return llamaResponse{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return llamaResponse{}, err
	}
	var r llamaResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return llamaResponse{}, err
	}
	return r, nil
}

func runOnce() {
	// Chain-scoped overviews first: one request each, Solana-only totals
	// for every protocol. Errors degrade to the per-protocol fallback.
	ovDex, errD := fetchOverview("dexs", "")
	if errD != nil {
		fmt.Printf("[poll] overview dexs: %v (falling back to summaries)\n", errD)
	}
	ovFees, errF := fetchOverview("fees", "dataType=dailyRevenue")
	if errF != nil {
		fmt.Printf("[poll] overview fees: %v (falling back to summaries)\n", errF)
	}

	for _, p := range platforms {
		vol, volOK := lookup(ovDex, p.names)
		if !volOK {
			v, err := fetch("dexs", p.slug, "")
			if err != nil {
				fmt.Printf("[poll] volume %s: %v\n", p.slug, err)
				health.WithLabelValues(p.label).Set(0)
				continue
			}
			fmt.Printf("[poll] %s: absent from solana overview, using all-chain summary\n", p.label)
			vol = v
		}

		rev, revOK := lookup(ovFees, p.names)
		if !revOK {
			r, err := fetch("fees", p.slug, "dataType=dailyRevenue")
			if err != nil {
				fmt.Printf("[poll] fees %s: %v (volume ok)\n", p.slug, err)
			}
			rev = r
		}

		volume24h.WithLabelValues(p.label).Set(vol.Total24h)
		volume7d.WithLabelValues(p.label).Set(vol.Total7d)
		fees24h.WithLabelValues(p.label).Set(rev.Total24h)
		fees7d.WithLabelValues(p.label).Set(rev.Total7d)
		if vol.Total24h > 0 {
			takeRate.WithLabelValues(p.label).Set(rev.Total24h / vol.Total24h)
		}
		health.WithLabelValues(p.label).Set(1)
		fmt.Printf("[poll] %s: vol24=$%.0f vol7d=$%.0f rev24=$%.0f rate=%.4f\n",
			p.label, vol.Total24h, vol.Total7d, rev.Total24h, rev.Total24h/max(vol.Total24h, 1))
	}
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
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
