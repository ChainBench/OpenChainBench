package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("exec-api: connect: %v", err)
	}
	defer pool.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/api/exec-leaderboard", corsJSON(handleExecLeaderboard(pool)))
	mux.HandleFunc("/api/evm-revenue", corsJSON(handleEVMRevenue(pool)))

	addr := ":2116"
	log.Printf("exec-api listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("exec-api: serve: %v", err)
	}
}

// WindowStats holds aggregated execution metrics for one time window.
type WindowStats struct {
	TxCount                int64   `json:"txCount"`
	AvgPriorityFeeLamports float64 `json:"avgPriorityFeeLamports"`
	P50CUPriceMicro        float64 `json:"p50CUPriceMicro"`
	P95CUPriceMicro        float64 `json:"p95CUPriceMicro"`
	AvgPlatformFeeLamports float64 `json:"avgPlatformFeeLamports"`
	SumPlatformFeeLamports int64   `json:"sumPlatformFeeLamports"`
	JitoRate               float64 `json:"jitoRate"`
	AvgCUConsumed          float64 `json:"avgCUConsumed"`
}

type PlatformRow struct {
	Platform  string                 `json:"platform"`
	LatestBkt string                 `json:"latestBucket"`
	Windows   map[string]WindowStats `json:"windows"`
}

type ExecLeaderboardResponse struct {
	UpdatedAt string        `json:"updatedAt"`
	Platforms []PlatformRow `json:"platforms"`
}

func handleExecLeaderboard(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		rows, err := pool.Query(ctx, `
			WITH cu AS (
				SELECT platform,
					percentile_cont(0.5) WITHIN GROUP (ORDER BY cu_price_micro)
						FILTER (WHERE block_time >= now() - INTERVAL '24 hours') AS h24_p50,
					percentile_cont(0.95) WITHIN GROUP (ORDER BY cu_price_micro)
						FILTER (WHERE block_time >= now() - INTERVAL '24 hours') AS h24_p95,
					percentile_cont(0.5) WITHIN GROUP (ORDER BY cu_price_micro)
						FILTER (WHERE block_time >= now() - INTERVAL '7 days') AS d7_p50,
					percentile_cont(0.95) WITHIN GROUP (ORDER BY cu_price_micro)
						FILTER (WHERE block_time >= now() - INTERVAL '7 days') AS d7_p95,
					percentile_cont(0.5) WITHIN GROUP (ORDER BY cu_price_micro)
						FILTER (WHERE block_time >= now() - INTERVAL '30 days') AS d30_p50,
					percentile_cont(0.95) WITHIN GROUP (ORDER BY cu_price_micro)
						FILTER (WHERE block_time >= now() - INTERVAL '30 days') AS d30_p95
				FROM solana_exec_cu_samples
				GROUP BY platform
			)
			SELECT
				f.platform,
				-- weighted averages: SUM(avg×count)/SUM(count) avoids skewing by small off-peak buckets
				SUM(f.avg_priority_fee_lamports * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours'), 0) AS h24_prio,
				MAX(c.h24_p50) AS h24_p50,
				MAX(c.h24_p95) AS h24_p95,
				SUM(f.avg_platform_fee_lamports * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours'), 0) AS h24_pfee,
				COALESCE(SUM(f.sum_platform_fee_lamports) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours'), 0) AS h24_sum_pfee,
				SUM(f.jito_rate * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours'), 0) AS h24_jito,
				SUM(f.avg_cu_consumed * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours'), 0) AS h24_cu,
				SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '24 hours') AS h24_count,

				SUM(f.avg_priority_fee_lamports * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days'), 0) AS d7_prio,
				MAX(c.d7_p50) AS d7_p50,
				MAX(c.d7_p95) AS d7_p95,
				SUM(f.avg_platform_fee_lamports * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days'), 0) AS d7_pfee,
				COALESCE(SUM(f.sum_platform_fee_lamports) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days'), 0) AS d7_sum_pfee,
				SUM(f.jito_rate * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days'), 0) AS d7_jito,
				SUM(f.avg_cu_consumed * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days'), 0) AS d7_cu,
				SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '7 days') AS d7_count,

				SUM(f.avg_priority_fee_lamports * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days'), 0) AS d30_prio,
				MAX(c.d30_p50) AS d30_p50,
				MAX(c.d30_p95) AS d30_p95,
				SUM(f.avg_platform_fee_lamports * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days'), 0) AS d30_pfee,
				COALESCE(SUM(f.sum_platform_fee_lamports) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days'), 0) AS d30_sum_pfee,
				SUM(f.jito_rate * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days'), 0) AS d30_jito,
				SUM(f.avg_cu_consumed * f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days')
				  / NULLIF(SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days'), 0) AS d30_cu,
				SUM(f.tx_count) FILTER (WHERE f.bucket_start >= now() - INTERVAL '30 days') AS d30_count,

				MAX(f.bucket_start)::text AS latest_bucket
			FROM solana_exec_facts f
			LEFT JOIN cu c USING (platform)
			WHERE f.bucket_start >= now() - INTERVAL '31 days'
			GROUP BY f.platform`,
		)
		if err != nil {
			log.Printf("exec-api: query: %v", err)
			http.Error(w, "internal", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var platforms []PlatformRow
		for rows.Next() {
			var plt, latestBkt string
			var h24Prio, h24P50, h24P95, h24Pfee, h24Jito, h24Cu *float64
			var h24SumPfee int64
			var h24Count *int64
			var d7Prio, d7P50, d7P95, d7Pfee, d7Jito, d7Cu *float64
			var d7SumPfee int64
			var d7Count *int64
			var d30Prio, d30P50, d30P95, d30Pfee, d30Jito, d30Cu *float64
			var d30SumPfee int64
			var d30Count *int64

			if err := rows.Scan(
				&plt,
				&h24Prio, &h24P50, &h24P95, &h24Pfee, &h24SumPfee, &h24Jito, &h24Cu, &h24Count,
				&d7Prio, &d7P50, &d7P95, &d7Pfee, &d7SumPfee, &d7Jito, &d7Cu, &d7Count,
				&d30Prio, &d30P50, &d30P95, &d30Pfee, &d30SumPfee, &d30Jito, &d30Cu, &d30Count,
				&latestBkt,
			); err != nil {
				log.Printf("exec-api: scan: %v", err)
				continue
			}

			p := PlatformRow{
				Platform:  plt,
				LatestBkt: latestBkt,
				Windows: map[string]WindowStats{
					"24h": buildWindow(h24Prio, h24P50, h24P95, h24Pfee, h24SumPfee, h24Jito, h24Cu, h24Count),
					"7d":  buildWindow(d7Prio, d7P50, d7P95, d7Pfee, d7SumPfee, d7Jito, d7Cu, d7Count),
					"30d": buildWindow(d30Prio, d30P50, d30P95, d30Pfee, d30SumPfee, d30Jito, d30Cu, d30Count),
				},
			}
			platforms = append(platforms, p)
		}

		// Sort by 30d tx count descending.
		sort.Slice(platforms, func(i, j int) bool {
			return platforms[i].Windows["30d"].TxCount > platforms[j].Windows["30d"].TxCount
		})

		resp := ExecLeaderboardResponse{
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Platforms: platforms,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

func buildWindow(prio, p50, p95, pfee *float64, sumPfee int64, jito, cu *float64, count *int64) WindowStats {
	ws := WindowStats{}
	if count != nil {
		ws.TxCount = *count
	}
	if prio != nil {
		ws.AvgPriorityFeeLamports = *prio
	}
	if p50 != nil {
		ws.P50CUPriceMicro = *p50
	}
	if p95 != nil {
		ws.P95CUPriceMicro = *p95
	}
	if pfee != nil {
		ws.AvgPlatformFeeLamports = *pfee
	}
	ws.SumPlatformFeeLamports = sumPfee
	if jito != nil {
		ws.JitoRate = *jito
	}
	if cu != nil {
		ws.AvgCUConsumed = *cu
	}
	return ws
}

func corsJSON(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
		h(w, r)
	}
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing env: %s", key)
	}
	return v
}

// ---- EVM revenue endpoint ----

// evmCoverage is the static coverage map derived from the evm-exec platform config.
// "full" = native + stable; "stable-only" = only ERC-20 USDC tracked.
var evmCoverage = map[string]map[string]string{
	"gmgn":    {"ethereum": "full", "bsc": "full", "base": "stable-only"},
	"pumpfun": {"ethereum": "full", "bsc": "full", "base": "stable-only"},
}

// coinGeckoIDs maps chain name → CoinGecko asset ID for native price lookup.
var coinGeckoIDs = map[string]string{
	"ethereum":  "ethereum",
	"bsc":       "binancecoin",
	"base":      "ethereum",
	"robinhood": "ethereum",
}

// nativeSymbols maps chain → native asset ticker.
var nativeSymbols = map[string]string{
	"ethereum":  "ETH",
	"bsc":       "BNB",
	"base":      "ETH",
	"robinhood": "ETH",
}

type priceCache struct {
	mu        sync.Mutex
	prices    map[string]float64 // coingecko id → USD price
	fetchedAt time.Time
}

var globalPrices = &priceCache{prices: make(map[string]float64)}

func (p *priceCache) get(ctx context.Context) map[string]float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.fetchedAt) < 15*time.Minute && len(p.prices) > 0 {
		out := make(map[string]float64, len(p.prices))
		for k, v := range p.prices {
			out[k] = v
		}
		return out
	}
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet,
		"https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin&vs_currencies=usd", nil)
	if err != nil {
		return nil
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var raw map[string]map[string]float64
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	for id, vs := range raw {
		if usd, ok := vs["usd"]; ok {
			p.prices[id] = usd
		}
	}
	p.fetchedAt = time.Now()
	out := make(map[string]float64, len(p.prices))
	for k, v := range p.prices {
		out[k] = v
	}
	return out
}

type NativeRevenue struct {
	Symbol string   `json:"symbol"`
	Amount float64  `json:"amount"`
	USD    *float64 `json:"usd"`
}

type EVMChainRevenue struct {
	Stable24h float64        `json:"stable24h"`
	Stable7d  float64        `json:"stable7d"`
	Stable30d float64        `json:"stable30d"`
	Native    *NativeRevenue `json:"native"` // 24h only; historical prices not stored
	Coverage  string         `json:"coverage"`
}

type EVMPlatformRow struct {
	Platform string                     `json:"platform"`
	Chains   map[string]EVMChainRevenue `json:"chains"`
}

type EVMRevenueResponse struct {
	UpdatedAt string           `json:"updatedAt"`
	Platforms []EVMPlatformRow `json:"platforms"`
}

func handleEVMRevenue(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		rows, err := pool.Query(ctx, `
			SELECT chain, platform,
			       COALESCE(SUM(revenue_stable) FILTER (WHERE bucket_start >= now() - INTERVAL '24 hours'), 0),
			       COALESCE(SUM(revenue_stable) FILTER (WHERE bucket_start >= now() - INTERVAL '7 days'), 0),
			       COALESCE(SUM(revenue_stable) FILTER (WHERE bucket_start >= now() - INTERVAL '30 days'), 0),
			       COALESCE(SUM(revenue_native) FILTER (WHERE bucket_start >= now() - INTERVAL '24 hours'), 0),
			       COALESCE(MAX(native_symbol), '')
			FROM evm_exec_facts
			WHERE bucket_start >= now() - INTERVAL '30 days'
			GROUP BY chain, platform`)
		if err != nil {
			log.Printf("evm-revenue: query: %v", err)
			http.Error(w, "internal", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		prices := globalPrices.get(r.Context())

		// Group by platform.
		byPlatform := make(map[string]map[string]EVMChainRevenue)
		for rows.Next() {
			var chain, plt, nativeSym string
			var stable24h, stable7d, stable30d, native float64
			if err := rows.Scan(&chain, &plt, &stable24h, &stable7d, &stable30d, &native, &nativeSym); err != nil {
				continue
			}
			if byPlatform[plt] == nil {
				byPlatform[plt] = make(map[string]EVMChainRevenue)
			}

			coverage := "stable-only"
			if m, ok := evmCoverage[plt]; ok {
				if c, ok := m[chain]; ok {
					coverage = c
				}
			}

			var nat *NativeRevenue
			if native > 0 || coverage == "full" {
				sym := nativeSym
				if sym == "" {
					sym = nativeSymbols[chain]
				}
				nr := &NativeRevenue{Symbol: sym, Amount: native}
				if cgID := coinGeckoIDs[chain]; cgID != "" && prices != nil {
					if price, ok := prices[cgID]; ok {
						usd := native * price
						nr.USD = &usd
					}
				}
				nat = nr
			}

			byPlatform[plt][chain] = EVMChainRevenue{
				Stable24h: stable24h,
				Stable7d:  stable7d,
				Stable30d: stable30d,
				Native:    nat,
				Coverage:  coverage,
			}
		}
		if err := rows.Err(); err != nil {
			log.Printf("evm-revenue: rows: %v", err)
		}

		var platforms []EVMPlatformRow
		for plt, chains := range byPlatform {
			platforms = append(platforms, EVMPlatformRow{Platform: plt, Chains: chains})
		}
		sort.Slice(platforms, func(i, j int) bool {
			return platforms[i].Platform < platforms[j].Platform
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(EVMRevenueResponse{
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Platforms: platforms,
		})
	}
}
