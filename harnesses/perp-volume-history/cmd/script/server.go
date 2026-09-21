package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// Bench 266 gauges. window is 1d (last closed UTC day), 7d or 30d
	// (sums over closed days, published only when every day is present).
	volume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_usd",
		Help: "Perp DEX notional volume in USD over closed UTC days: window=1d is the last closed day, 7d and 30d are sums.",
	}, []string{"venue", "window"})
	share = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_share_pct",
		Help: "Venue share of the cohort's volume on the window, in percent.",
	}, []string{"venue", "window"})
	cohortVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_cohort_usd",
		Help: "Sum of the cohort's volume on the window, in USD.",
	}, []string{"window"})
	historyDays = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_history_days",
		Help: "Number of UTC days stored for the venue (backfill depth).",
	}, []string{"venue"})
	health = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_health",
		Help: "1 when the venue has a closed-day figure within the last three days.",
	}, []string{"venue"})
	sourceUsed = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_source",
		Help: "1 for the upstream that produces the venue's published series.",
	}, []string{"venue", "source"})
	divergence = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_divergence_pct",
		Help: "Percent gap between a secondary source and the published one over the refreshed days (secondary minus published, over published).",
	}, []string{"venue", "secondary"})
	lastRefresh = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_daily_volume_last_refresh_unix",
		Help: "Unix time of the last successful fetch per venue and source.",
	}, []string{"venue", "source"})
	fetchErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "perp_daily_volume_fetch_errors_total",
		Help: "Fetch failures per venue and source.",
	}, []string{"venue", "source"})
	lastTick = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "perp_daily_volume_last_tick_unix",
		Help: "Unix time of the last completed sweep.",
	})
)

func init() {
	prometheus.MustRegister(volume, share, cohortVolume, historyDays, health, sourceUsed, divergence, lastRefresh, fetchErrors, lastTick)
}

// startServer serves /metrics for the shared Prometheus and /v1/history
// for the site. The history document is small (a few hundred KB) and
// rebuilt on each request from the in-memory store; the site caches it
// for minutes, and Caddy can serve the mirrored file instead.
func startServer(addr string, store *Store) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"venues": store.venueCount(),
			"points": store.pointCount(),
			"time":   time.Now().UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/v1/history", func(w http.ResponseWriter, r *http.Request) {
		doc := store.publicDoc(currentSources)
		if days, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && days > 0 {
			cut := fmtDay(utcDay(time.Now()).AddDate(0, 0, -days))
			for i := range doc.Venues {
				pts := doc.Venues[i].Days
				j := 0
				for j < len(pts) && pts[j].Day < cut {
					j++
				}
				doc.Venues[i].Days = pts[j:]
			}
		}
		if v := r.URL.Query().Get("venue"); v != "" {
			kept := doc.Venues[:0]
			for _, pv := range doc.Venues {
				if pv.Slug == v {
					kept = append(kept, pv)
				}
			}
			doc.Venues = kept
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "public, max-age=300, stale-while-revalidate=900")
		_ = json.NewEncoder(w).Encode(doc)
	})
	return http.ListenAndServe(addr, mux)
}

// currentSources is set once at boot so the HTTP handler can label the
// history document without threading the slice through the server.
var currentSources []Source
