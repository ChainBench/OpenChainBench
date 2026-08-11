package main

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	appStoreRating = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "app_store_rating",
		Help: "Apple App Store average user rating (0 to 5).",
	}, []string{"app"})

	appStoreReviews = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "app_store_reviews_total",
		Help: "Total number of user ratings in the Apple App Store.",
	}, []string{"app"})

	appStoreHealth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "app_store_health",
		Help: "1 if the iTunes lookup succeeded in the last poll.",
	}, []string{"app"})
)

func initMetrics() {}
