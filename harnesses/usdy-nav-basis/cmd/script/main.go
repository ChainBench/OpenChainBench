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
// NAV leg: getPrice() on Ondo's RWADynamicOracle for USDY on Ethereum,
// the redemption price the issuer publishes onchain (one eth_call a
// minute through RPC_ETHEREUM). Market legs, both executable prices for
// a sale of 1,000 USDY into USDC quoted by Jupiter's keyless lite API:
// "orca-solana" restricted to the Orca whirlpool (dexes=Whirlpool, fee
// and impact included) and "jupiter-solana" on the best open route. The
// whirlpool mid decoded from getAccountInfo (sqrtPrice u128 LE at bytes
// 65..81, both mints 6 decimals) is exported as a reference gauge only.
//
// History: until 2026-08-26 the NAV and a market composite came from one
// Pyth Hermes call; Hermes then put price updates behind a key (401),
// the harness failed silently and the gauges stayed frozen for a month.
// A failed leg now deletes its gauge children instead.
//
// Excluded, verified 2026-07-13: the Arbitrum Camelot pool holds 232
// USDY against 7M USDC (drained), its price sits ~345 bps off NAV and
// moves nothing; kept out of the ranking, documented in the spec as
// the cautionary example of why pool depth gates peg quality.
//
// One eth_call, one Solana getAccountInfo and two Jupiter quotes per tick.

const (
	// Ondo's RWADynamicOracle for USDY on Ethereum: getPrice() returns the
	// current redemption price per USDY, 18 decimals. This is the rate a
	// redeeming holder receives, published by the issuer onchain. Until
	// 2026-08-26 the NAV came from the Pyth Hermes RR feed; Hermes price
	// updates now answer 401 without a key, and the harness ran a month
	// on frozen gauges before anyone noticed (fixed 2026-09-23).
	ondoOracle   = "0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0"
	getPriceSel  = "0x98d5fdca"
	orcaPool     = "AGXrswVDRoUf62UX9voTXv6TCGw6fBUEwDpyUd9YdZfD"
	usdyMint     = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"
	usdcMint     = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	jupiterQuote = "https://lite-api.jup.ag/swap/v1/quote"
	// Jupiter quote size: 1,000 USDY (6 decimals), about $1,150 at the
	// 2026-09 NAV; the executable price includes fee and route impact,
	// which is the point of a market leg.
	jupiterAmount = "1000000000"

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
		Help: "USDY official redemption price from Ondo's RWADynamicOracle on Ethereum (getPrice, 18 decimals).",
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

	lastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "usdy_last_success_timestamp_seconds",
		Help: "Unix time of the last tick on which the venue produced a basis sample. A gauge that stops advancing is a frozen leg, which a scrape timestamp cannot show (the Hermes leg froze for a month in 2026-08).",
	}, []string{"venue"})

	poolMid = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "usdy_pool_mid_price_usd",
		Help: "Orca USDY/USDC whirlpool mid price decoded from the pool account (reference only; the ranked venues are executable prices).",
	})
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
	fmt.Println("OpenChainBench — USDY market price vs official redemption rate (Ondo onchain oracle).")

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
	venues := []string{"orca-solana", "jupiter-solana"}
	// A failed leg publishes nothing: the gauge child goes, so a frozen
	// value can never sit in a 24h median as if it were measured (the
	// Hermes leg did exactly that for a month, 2026-08-26 to 09-23).
	fail := func(venue string) {
		healthGauge.WithLabelValues(venue).Set(0)
		basisBps.DeleteLabelValues(venue)
		marketPrice.DeleteLabelValues(venue)
	}
	tick := func() {
		nav := fetchOndoNAV(client)
		if nav <= 0 {
			for _, v := range venues {
				fail(v)
			}
			fmt.Println("[nav] no redemption price this tick (see usdy_source_call_total{source=\"ondo\"})")
			return
		}
		navGauge.Set(nav)
		if mid := fetchOrca(client); mid > 0 && math.Abs(mid-nav)/nav < 0.05 {
			poolMid.Set(mid)
		}

		// Both ranked legs are executable prices for the same 1,000 USDY
		// sale, quoted by Jupiter: one restricted to the Orca whirlpool
		// (fee and impact included), one on the best open route. Like
		// for like; a pool mid against an executable quote crowned the
		// worse exit (audit 2026-09-23).
		emit := func(venue string, price float64) {
			// A price more than 5 % from NAV is a wrong decode or a broken
			// route, not a market: USDY has never traded that far.
			if price <= 0 || math.Abs(price-nav)/nav > 0.05 {
				fail(venue)
				return
			}
			marketPrice.WithLabelValues(venue).Set(price)
			bps := (price - nav) / nav * 10000
			basisBps.WithLabelValues(venue).Set(bps)
			healthGauge.WithLabelValues(venue).Set(1)
			lastSuccess.WithLabelValues(venue).Set(float64(time.Now().Unix()))
			fmt.Printf("[%s] price=%.6f nav=%.6f basis=%+.1fbps\n", venue, price, nav, bps)
		}
		emit("orca-solana", fetchJupiter(client, "Whirlpool"))
		emit("jupiter-solana", fetchJupiter(client, ""))
	}

	tick()
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for range t.C {
		tick()
	}
}

// fetchOndoNAV reads getPrice() on Ondo's USDY oracle through the
// Ethereum RPC in RPC_ETHEREUM (a keyed endpoint on the VPS; the public
// default is rate limited but works for one call a minute).
func fetchOndoNAV(client *http.Client) float64 {
	body := []byte(fmt.Sprintf(
		`{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"%s","data":"%s"},"latest"]}`,
		ondoOracle, getPriceSel,
	))
	req, _ := http.NewRequest("POST", envDefault("RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues("ondo", "network").Inc()
		return 0
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues("ondo", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return 0
	}
	var envel struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || len(envel.Result) < 3 {
		sourceCall.WithLabelValues("ondo", "parse").Inc()
		return 0
	}
	wei, ok := new(big.Int).SetString(strings.TrimPrefix(envel.Result, "0x"), 16)
	if !ok || wei.Sign() <= 0 {
		sourceCall.WithLabelValues("ondo", "decode").Inc()
		return 0
	}
	f, _ := new(big.Float).Quo(new(big.Float).SetInt(wei), big.NewFloat(1e18)).Float64()
	// USDY started at $1 in 2023 and accrues about 4 to 5 % a year; a
	// price outside [1, 2] is a wrong oracle, not a NAV.
	if f < 1 || f > 2 {
		sourceCall.WithLabelValues("ondo", "range").Inc()
		return 0
	}
	sourceCall.WithLabelValues("ondo", "ok").Inc()
	return f
}

// fetchJupiter returns the executable USDY price in USDC for a sale of
// 1,000 USDY (about $1,150 at today's NAV) routed by Jupiter (lite API,
// keyless): out / in, both 6 decimals. `dexes` restricts the route to
// one venue ("Whirlpool" = the Orca pool); empty means the best route.
func fetchJupiter(client *http.Client, dexes string) float64 {
	url := jupiterQuote + "?inputMint=" + usdyMint + "&outputMint=" + usdcMint + "&amount=" + jupiterAmount + "&slippageBps=50"
	if dexes != "" {
		// The restricted leg must be the named pool, not "any Orca route":
		// single hop only, and the route plan is checked below against
		// orcaPool (review 2026-09-23).
		url += "&dexes=" + dexes + "&onlyDirectRoutes=true"
	}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues("jupiter", "network").Inc()
		return 0
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues("jupiter", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return 0
	}
	var q struct {
		InAmount  string `json:"inAmount"`
		OutAmount string `json:"outAmount"`
		RoutePlan []struct {
			SwapInfo struct {
				AmmKey string `json:"ammKey"`
				Label  string `json:"label"`
			} `json:"swapInfo"`
		} `json:"routePlan"`
	}
	if err := json.Unmarshal(raw, &q); err != nil {
		sourceCall.WithLabelValues("jupiter", "parse").Inc()
		return 0
	}
	if dexes != "" && (len(q.RoutePlan) != 1 || q.RoutePlan[0].SwapInfo.AmmKey != orcaPool) {
		// Another whirlpool or a two-hop route won the quote: that is
		// not the pool the row is named after, publish nothing.
		sourceCall.WithLabelValues("jupiter", "wrong_pool").Inc()
		return 0
	}
	in, err1 := strconv.ParseFloat(q.InAmount, 64)
	out, err2 := strconv.ParseFloat(q.OutAmount, 64)
	if err1 != nil || err2 != nil || in <= 0 || out <= 0 {
		sourceCall.WithLabelValues("jupiter", "decode").Inc()
		return 0
	}
	sourceCall.WithLabelValues("jupiter", "ok").Inc()
	return out / in
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
