package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var apps = []struct {
	slug string
	id   string
}{
	{"pumpfun", "6717572591"},
	{"fomo", "6741115427"},
	{"gmgn", "6745328711"},
	{"moonshot", "6503993131"},
	{"coinbase", "886427730"},
	{"bybit", "1488296980"},
	{"kraken", "1481947260"},
	{"binance-us", "1492670702"},
}

func main() {
	initMetrics()

	if err := runOnce(); err != nil {
		fmt.Fprintf(os.Stderr, "[app-store] first run: %v\n", err)
	}

	go func() {
		tick := time.NewTicker(30 * time.Minute)
		for range tick.C {
			if err := runOnce(); err != nil {
				fmt.Fprintf(os.Stderr, "[app-store] poll: %v\n", err)
			}
		}
	}()

	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	fmt.Println("[app-store-ratings] metrics on :2112")
	if err := http.ListenAndServe(":2112", nil); err != nil {
		fmt.Fprintf(os.Stderr, "server: %v\n", err)
		os.Exit(1)
	}
}

func runOnce() error {
	for _, app := range apps {
		data, err := fetchAppStoreData(app.id)
		if err != nil {
			fmt.Printf("[app-store] %s: %v\n", app.slug, err)
			appStoreHealth.WithLabelValues(app.slug).Set(0)
			continue
		}
		appStoreRating.WithLabelValues(app.slug).Set(data.Rating)
		appStoreReviews.WithLabelValues(app.slug).Set(float64(data.ReviewCount))
		appStoreHealth.WithLabelValues(app.slug).Set(1)
		fmt.Printf("[app-store] %s: rating=%.4f reviews=%d\n", app.slug, data.Rating, data.ReviewCount)
	}
	return nil
}
