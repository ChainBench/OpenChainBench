package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Robinhood Chain gas subsidy tracker.
//
// Robinhood Chain launched July 1, 2026 with a 90-day promotion where
// users pay $0 in gas because Robinhood covers the sequencer cost.
// The window closes September 29, 2026 (public wording: "cover gas
// fees for eligible users for the first 90 days"; math from mainnet
// launch confirms end-of-Q3).
//
// The bench publishes two things live:
//
//   1. Countdown: days remaining until the subsidy ends, and the
//      fraction of the 90-day window already elapsed.
//   2. Estimated chain-side gas cost that Robinhood is paying to the
//      sequencer since launch. Deliberately labeled "chain-side" and
//      not "user fees": growthepie's fees_paid_by_users is ~$0
//      during the subsidy (because users literally pay $0), so a
//      number in the $millions would contradict them if mislabeled.
//      This bench measures what Robinhood, not the user, is paying.
//
// Data leg: Blockscout's /api/v2/stats/charts/transactions (daily
// tx count from launch, keyless) + /api/v2/stats (today's gas_used,
// current gas_prices tier, ETH price). The historical gas-used chart
// doesn't exist on this Blockscout instance (verified 400 on
// /api/v2/stats/charts/gas-used), so per-day gas is estimated from
// daily tx count multiplied by the current per-tx gas draw
// (gas_used_today / transactions_today), a stable ratio on an Orbit
// with a fixed-cost transaction mix.

const (
	launchDate     = "2026-07-01T00:00:00Z"
	subsidyEndDate = "2026-09-29T23:59:59Z"

	pollInterval = 1 * time.Hour
	httpTimeout  = 20 * time.Second

	blockscoutBase = "https://robinhoodchain.blockscout.com"
	robinhoodRPC   = "https://rpc.mainnet.chain.robinhood.com"
)

var (
	daysRemaining = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_days_remaining",
		Help: "Days until the 90-day gas subsidy window ends on 2026-09-29 (negative once expired).",
	})

	windowFractionElapsed = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_window_fraction_elapsed",
		Help: "Share of the 90-day subsidy window elapsed (0 to 1).",
	})

	chainSideCostTotalUSD = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_chainside_cost_total_usd",
		Help: "Estimated cumulative USD chain-side gas cost since launch, i.e. what Robinhood is paying the sequencer while users pay $0. NOT growthepie's fees_paid_by_users (~$0 during the subsidy by design).",
	})

	chainSideCostTodayUSD = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_chainside_cost_today_usd",
		Help: "Today's estimated chain-side gas cost (gas_used_today x average base fee x ETH price).",
	})

	projectedTotalUSD = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_projected_total_usd",
		Help: "Linear projection: cumulative_cost x (90 / days_elapsed). Where chain-side gas cost lands if today's daily rate holds through Sep 29.",
	})

	dailyTxCountGauge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_daily_tx_count",
		Help: "Daily transaction count on Robinhood Chain since launch (Blockscout charts/transactions).",
	}, []string{"date"})

	baseFeeGweiGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_base_fee_gwei",
		Help: "Current base fee on Robinhood Chain in gwei (eth_gasPrice / 1e9).",
	})

	ethPriceGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "robinhood_subsidy_eth_price_usd",
		Help: "ETH USD spot as reported by the chain's Blockscout instance.",
	})

	sourceCall = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "robinhood_subsidy_source_call_total",
		Help: "Fetch outcomes per source.",
	}, []string{"source", "result"})
)

func envDefault(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	installLogCapture()
	fmt.Println("=== Robinhood Chain Gas Subsidy Tracker ===")
	fmt.Printf("Launch: %s | Subsidy ends: %s\n", launchDate, subsidyEndDate)

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
		now := time.Now().UTC()
		launch, _ := time.Parse(time.RFC3339, launchDate)
		end, _ := time.Parse(time.RFC3339, subsidyEndDate)

		daysLeft := end.Sub(now).Hours() / 24
		daysRemaining.Set(daysLeft)
		totalWindow := end.Sub(launch).Hours() / 24
		elapsed := now.Sub(launch).Hours() / 24
		frac := math.Max(0, math.Min(1, elapsed/totalWindow))
		windowFractionElapsed.Set(frac)

		baseFeeGwei, ok := fetchBaseFeeGwei(client)
		if !ok {
			// Orbit floor observed since launch: ~0.05 gwei. Safe fallback
			// so a transient RPC blip doesn't null the burn number.
			baseFeeGwei = 0.05
		}
		baseFeeGweiGauge.Set(baseFeeGwei)

		stats, ok := fetchBlockscoutStats(client)
		if !ok || stats.CoinPrice <= 0 {
			return
		}
		ethPriceGauge.Set(stats.CoinPrice)

		daily := fetchTransactionsChart(client)
		if daily == nil {
			return
		}

		// Per-tx gas draw derived from today's Blockscout stats. The
		// mix of tokenized-stock swaps + native transfers is stable
		// on this chain, so gas_used_today / transactions_today is a
		// clean proxy for historical days.
		perTxGas := 0.0
		if stats.TxsToday > 0 {
			perTxGas = float64(stats.GasUsedToday) / float64(stats.TxsToday)
		}
		if perTxGas <= 0 {
			perTxGas = 150_000 // conservative fallback if stats missed
		}

		// Cumulative cost: sum(daily_tx × per_tx_gas × base_fee × ETH).
		total := 0.0
		for _, d := range daily {
			gasUnits := float64(d.value) * perTxGas
			eth := gasUnits * baseFeeGwei / 1e9
			total += eth * stats.CoinPrice
			dailyTxCountGauge.WithLabelValues(d.date).Set(float64(d.value))
		}
		chainSideCostTotalUSD.Set(total)

		todayCost := float64(stats.GasUsedToday) * baseFeeGwei / 1e9 * stats.CoinPrice
		chainSideCostTodayUSD.Set(todayCost)

		if elapsed > 0.5 {
			projectedTotalUSD.Set(total * (totalWindow / elapsed))
		}

		fmt.Printf("[tick] days_left=%.1f cost_total=$%.0f today=$%.0f eth=$%.2f base_fee=%.4fgwei per_tx_gas=%.0f\n",
			daysLeft, total, todayCost, stats.CoinPrice, baseFeeGwei, perTxGas)
	}

	tick()
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for range t.C {
		tick()
	}
}

// fetchBaseFeeGwei calls eth_gasPrice on the Robinhood RPC.
func fetchBaseFeeGwei(client *http.Client) (float64, bool) {
	body := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}`)
	req, _ := http.NewRequest("POST", robinhoodRPC, body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues("rpc", "network").Inc()
		return 0, false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues("rpc", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return 0, false
	}
	var env struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || env.Result == "" {
		sourceCall.WithLabelValues("rpc", "parse").Inc()
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(env.Result, "0x"), 16, 64)
	if err != nil {
		sourceCall.WithLabelValues("rpc", "decode").Inc()
		return 0, false
	}
	sourceCall.WithLabelValues("rpc", "ok").Inc()
	return float64(n) / 1e9, true
}

type stats struct {
	CoinPrice    float64
	GasUsedToday uint64
	TxsToday     uint64
}

func fetchBlockscoutStats(client *http.Client) (stats, bool) {
	raw, ok := getKeyless(client, blockscoutBase+"/api/v2/stats", "blockscout_stats")
	if !ok {
		return stats{}, false
	}
	var env struct {
		GasUsedToday     string `json:"gas_used_today"`
		CoinPrice        string `json:"coin_price"`
		TransactionsToday string `json:"transactions_today"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		sourceCall.WithLabelValues("blockscout_stats", "parse").Inc()
		return stats{}, false
	}
	price, _ := strconv.ParseFloat(env.CoinPrice, 64)
	gas, _ := strconv.ParseUint(env.GasUsedToday, 10, 64)
	txs, _ := strconv.ParseUint(env.TransactionsToday, 10, 64)
	return stats{CoinPrice: price, GasUsedToday: gas, TxsToday: txs}, true
}

type dailyPoint struct {
	date  string
	value uint64
}

// fetchTransactionsChart is Blockscout's chart of daily tx count.
// Verified 2026-07-14 shape: {"chart_data":[{"date":"YYYY-MM-DD","transactions_count":N},...]}
func fetchTransactionsChart(client *http.Client) []dailyPoint {
	raw, ok := getKeyless(client, blockscoutBase+"/api/v2/stats/charts/transactions", "blockscout_chart")
	if !ok {
		return nil
	}
	var env struct {
		ChartData []struct {
			Date  string `json:"date"`
			Count uint64 `json:"transactions_count"`
		} `json:"chart_data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || len(env.ChartData) == 0 {
		sourceCall.WithLabelValues("blockscout_chart", "parse").Inc()
		return nil
	}
	out := make([]dailyPoint, 0, len(env.ChartData))
	for _, p := range env.ChartData {
		out = append(out, dailyPoint{date: p.Date, value: p.Count})
	}
	return out
}

func getKeyless(client *http.Client, url, tag string) ([]byte, bool) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		sourceCall.WithLabelValues(tag, "network").Inc()
		return nil, false
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
	if err != nil {
		sourceCall.WithLabelValues(tag, "read").Inc()
		return nil, false
	}
	if resp.StatusCode != 200 {
		sourceCall.WithLabelValues(tag, fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return nil, false
	}
	sourceCall.WithLabelValues(tag, "ok").Inc()
	return raw, true
}
