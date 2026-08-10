package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sort"
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
			var h24Count *int64
			var d7Prio, d7P50, d7P95, d7Pfee, d7Jito, d7Cu *float64
			var d7Count *int64
			var d30Prio, d30P50, d30P95, d30Pfee, d30Jito, d30Cu *float64
			var d30Count *int64

			if err := rows.Scan(
				&plt,
				&h24Prio, &h24P50, &h24P95, &h24Pfee, &h24Jito, &h24Cu, &h24Count,
				&d7Prio, &d7P50, &d7P95, &d7Pfee, &d7Jito, &d7Cu, &d7Count,
				&d30Prio, &d30P50, &d30P95, &d30Pfee, &d30Jito, &d30Cu, &d30Count,
				&latestBkt,
			); err != nil {
				log.Printf("exec-api: scan: %v", err)
				continue
			}

			p := PlatformRow{
				Platform:  plt,
				LatestBkt: latestBkt,
				Windows: map[string]WindowStats{
					"24h": buildWindow(h24Prio, h24P50, h24P95, h24Pfee, h24Jito, h24Cu, h24Count),
					"7d":  buildWindow(d7Prio, d7P50, d7P95, d7Pfee, d7Jito, d7Cu, d7Count),
					"30d": buildWindow(d30Prio, d30P50, d30P95, d30Pfee, d30Jito, d30Cu, d30Count),
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

func buildWindow(prio, p50, p95, pfee, jito, cu *float64, count *int64) WindowStats {
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
