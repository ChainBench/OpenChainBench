package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// usdy-nav-basis: live basis between USDY's (Ondo tokenized treasury)
// onchain market price and its official redemption rate (NAV).
//
// NAV leg: Pyth Hermes "Crypto.USDY/USD.RR" redemption-rate feed. The
// same Hermes call also carries the Pyth USDY/USD market composite,
// which doubles as a cross-check venue row. Market leg: the Orca
// whirlpool USDY/USDC on Solana (deepest genuine pool, ~$2.9M),
// decoded straight from getAccountInfo (sqrtPrice u128 LE at bytes
// 65..81, both mints 6 decimals so no scale factor).
//
// Excluded, verified 2026-07-13: the Arbitrum Camelot pool holds 232
// USDY against 7M USDC (drained), its price sits ~345 bps off NAV and
// moves nothing; kept out of the ranking, documented in the spec as
// the cautionary example of why pool depth gates peg quality.
//
// All legs keyless. One Hermes GET + one Solana RPC POST per tick.

const (
	navFeedID    = "e3d1723999820435ebab53003a542ff26847720692af92523eea613a9a28d500"
	marketFeedID = "e393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326"
	orcaPool     = "AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD"

	pollInterval = 60 * time.Second
	httpTimeout  = 15 * time.Second
)

var (
	basisBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "usdy_basis_bps",
		Help: "Signed basis of the venue's USDY price vs the official redemption rate, in bps (positive = premium over NAV).",
	}, []string{"venue"})

	navGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "usdy_nav_usd",
		Help: "USDY official redemption rate from the Pyth RR feed.",
	})

	marketPrice = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "usdy_market_price_usd",
		Help: "USDY market price per venue.",
	}, []string{"venue"})

	sourceCall = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "usdy_source_call_total",
		Help: "Fetch outcomes per source.",
	}, []string{"source", "result"})

	healthGauge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "usdy_health",
		Help: "1 when the venue produced a basis sample on the last tick.",
	}, []string{"venue"})
)

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func main() {
	installLogCapture()
	fmt.Println("=== USDY NAV Basis Harness ===")
	fmt.Println("OpenChainBench — USDY market price vs official redemption rate, keyless.")

	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		mux.Handle("/logs", logsHandler())
		mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		})
		if err := http.ListenAndServe(envDefault("LISTEN_ADDR", ":2112"), mux); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
		}
	}()

	client := &http.Client{Timeout: httpTimeout}
	tick := func() {
		nav, market := fetchHermes(client)
		orca := fetchOrca(client)

		if nav <= 0 {
			healthGauge.WithLabelValues("orca-solana").Set(0)
			healthGauge.WithLabelValues("pyth-market").Set(0)
			return
		}
		navGauge.Set(nav)

		emit := func(venue string, price float64) {
			if price <= 0 {
				healthGauge.WithLabelValues(venue).Set(0)
				return
			}
			marketPrice.WithLabelValues(venue).Set(price)
			bps := (price - nav) / nav * 10000
			basisBps.WithLabelValues(venue).Set(bps)
			healthGauge.WithLabelValues(venue).Set(1)
			fmt.Printf("[%s] price=%.6f nav=%.6f basis=%+.1fbps\n", venue, price, nav, bps)
		}
		emit("orca-solana", orca)
		emit("pyth-market", market)
	}

	tick()
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for range t.C {
		tick()
	}
}

// fetchHermes returns (nav, market) from one Hermes call.
func fetchHermes(client *http.Client) (float64, float64) {
	url := "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x" + navFeedID + "&ids[]=0x" + marketFeedID
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues("hermes", "network").Inc()
		return 0, 0
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues("hermes", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return 0, 0
	}
	var envel struct {
		Parsed []struct {
			ID    string `json:"id"`
			Price struct {
				Price string `json:"price"`
				Expo  int    `json:"expo"`
			} `json:"price"`
		} `json:"parsed"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil {
		sourceCall.WithLabelValues("hermes", "parse").Inc()
		return 0, 0
	}
	nav, market := 0.0, 0.0
	for _, p := range envel.Parsed {
		v, err := strconv.ParseFloat(p.Price.Price, 64)
		if err != nil {
			continue
		}
		val := v * math.Pow10(p.Price.Expo)
		switch strings.TrimPrefix(strings.ToLower(p.ID), "0x") {
		case navFeedID:
			nav = val
		case marketFeedID:
			market = val
		}
	}
	sourceCall.WithLabelValues("hermes", "ok").Inc()
	return nav, market
}

// fetchOrca decodes the whirlpool sqrtPrice (u128 LE at bytes 65..81);
// USDY and USDC are both 6 decimals so price = (sqrtPrice/2^64)^2.
// publicnode.com burst-rate-limits us to ~40% getAccountInfo success on
// the VPS; 2 retries with backoff take that to >95% without changing RPCs.
func fetchOrca(client *http.Client) float64 {
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
		}
		if p := fetchOrcaOnce(client); p > 0 {
			return p
		}
	}
	return 0
}

func fetchOrcaOnce(client *http.Client) float64 {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","id":%d,"method":"getAccountInfo","params":["%s",{"encoding":"base64","commitment":"confirmed"}]}`,
		time.Now().UnixNano(), orcaPool,
	))
	req, _ := http.NewRequest("POST", envDefault("USDY_SOLANA_RPC", "https://solana-rpc.publicnode.com"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues("orca", "network").Inc()
		return 0
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues("orca", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return 0
	}
	var envel struct {
		Result struct {
			Value struct {
				Data []string `json:"data"`
			} `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || len(envel.Result.Value.Data) == 0 {
		sourceCall.WithLabelValues("orca", "parse").Inc()
		return 0
	}
	acct, err := base64.StdEncoding.DecodeString(envel.Result.Value.Data[0])
	if err != nil || len(acct) < 81 {
		sourceCall.WithLabelValues("orca", "decode").Inc()
		return 0
	}
	lo := binary.LittleEndian.Uint64(acct[65:73])
	hi := binary.LittleEndian.Uint64(acct[73:81])
	sqrtPrice := new(big.Float).SetPrec(200).SetInt(new(big.Int).Add(
		new(big.Int).Lsh(new(big.Int).SetUint64(hi), 64),
		new(big.Int).SetUint64(lo),
	))
	q64 := new(big.Float).SetPrec(200).SetInt(new(big.Int).Lsh(big.NewInt(1), 64))
	ratio := new(big.Float).Quo(sqrtPrice, q64)
	price := new(big.Float).Mul(ratio, ratio)
	f, _ := price.Float64()
	sourceCall.WithLabelValues("orca", "ok").Inc()
	return f
}
