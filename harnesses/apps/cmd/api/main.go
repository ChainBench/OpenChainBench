package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("apps-api: connect: %v", err)
	}
	defer pool.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/api/leaderboard", corsJSON(handleLeaderboard(pool)))

	addr := ":2115"
	log.Printf("apps-api listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("apps-api: serve: %v", err)
	}
}

type WindowMetrics struct {
	Gross float64 `json:"gross"`
	Burn  float64 `json:"burn"`
	LP    float64 `json:"lp"`
	Spot  float64 `json:"spot"`
}

type ProtocolRow struct {
	ID        string                   `json:"id"`
	Name      string                   `json:"name"`
	Slug      string                   `json:"slug"`
	Category  string                   `json:"category"`
	LatestDay string                   `json:"latestDay"`
	Windows   map[string]WindowMetrics `json:"windows"`
}

type LeaderboardResponse struct {
	UpdatedAt string        `json:"updatedAt"`
	Protocols []ProtocolRow `json:"protocols"`
}

var deploymentMeta = map[string]struct{ Name, Slug, Category string }{
	"hyperliquid:hypercore": {Name: "Hyperliquid", Slug: "hyperliquid", Category: "perps"},
	"dydx-v4:dydx-chain":   {Name: "dYdX", Slug: "dydx", Category: "perps"},
	"gmx-v2:arbitrum":      {Name: "GMX v2 (Arbitrum)", Slug: "gmx", Category: "perps"},
	"gmx-v2:avalanche":     {Name: "GMX v2 (Avalanche)", Slug: "gmx", Category: "perps"},
	"gains-trade:arbitrum": {Name: "Gains.trade", Slug: "gains-trade", Category: "perps"},
	"drift:solana":         {Name: "Drift", Slug: "drift", Category: "perps"},
	"jupiter-perps:solana": {Name: "Jupiter Perps", Slug: "jupiter-perps", Category: "perps"},
	"vertex:arbitrum":      {Name: "Vertex", Slug: "vertex", Category: "perps"},
}

func handleLeaderboard(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		rows, err := pool.Query(ctx, `
			SELECT
				deployment_id,
				beneficiary,
				component,
				SUM(CASE WHEN bucket_start >= now() - INTERVAL '2 days'  THEN amount_usd ELSE 0 END) AS h24,
				SUM(CASE WHEN bucket_start >= now() - INTERVAL '7 days'   THEN amount_usd ELSE 0 END) AS d7,
				SUM(CASE WHEN bucket_start >= now() - INTERVAL '30 days'  THEN amount_usd ELSE 0 END) AS d30,
				SUM(amount_usd) AS all_time,
				MAX(bucket_start)::text AS latest_day
			FROM fee_facts
			WHERE methodology_version = 1
			GROUP BY deployment_id, beneficiary, component
			ORDER BY deployment_id, beneficiary, component`,
		)
		if err != nil {
			log.Printf("leaderboard query: %v", err)
			http.Error(w, "internal", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		type key struct{ id, beneficiary, component string }
		type vals struct{ h24, d7, d30, allTime float64; latestDay string }
		data := map[key]vals{}

		for rows.Next() {
			var k key
			var v vals
			if err := rows.Scan(&k.id, &k.beneficiary, &k.component, &v.h24, &v.d7, &v.d30, &v.allTime, &v.latestDay); err != nil {
				continue
			}
			data[k] = v
		}

		// Aggregate per deployment into WindowMetrics.
		depMap := map[string]*ProtocolRow{}
		for k, v := range data {
			row, ok := depMap[k.id]
			if !ok {
				meta := deploymentMeta[k.id]
				row = &ProtocolRow{
					ID:       k.id,
					Name:     meta.Name,
					Slug:     meta.Slug,
					Category: meta.Category,
					Windows:  map[string]WindowMetrics{},
				}
				depMap[k.id] = row
			}
			if v.latestDay > row.LatestDay {
				row.LatestDay = v.latestDay
			}
			addToWindow := func(winKey string, amount float64) {
				wm := row.Windows[winKey]
				wm.Gross += amount
				switch k.beneficiary {
				case "burn", "treasury":
					wm.Burn += amount
				case "lp":
					wm.LP += amount
				}
				if k.component == "spot_fee" {
					wm.Spot += amount
				}
				row.Windows[winKey] = wm
			}
			addToWindow("24h", v.h24)
			addToWindow("7d", v.d7)
			addToWindow("30d", v.d30)
			addToWindow("allTime", v.allTime)
		}

		protocols := make([]ProtocolRow, 0, len(depMap))
		for _, row := range depMap {
			protocols = append(protocols, *row)
		}
		// Sort by 30d gross descending.
		for i := 1; i < len(protocols); i++ {
			for j := i; j > 0 && protocols[j].Windows["30d"].Gross > protocols[j-1].Windows["30d"].Gross; j-- {
				protocols[j], protocols[j-1] = protocols[j-1], protocols[j]
			}
		}

		resp := LeaderboardResponse{
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Protocols: protocols,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
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
