package main

import (
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	probeUA      = "OpenChainBench/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)"
	probeTimeout = 10 * time.Second
)

type venueProbe struct {
	Venue string
	URL   string
}

// venueProbes is the list of market-listing endpoints to probe.
// Each URL returns a 200 when the venue is accessible from the probe region,
// a 403 when geo-blocked, or a redirect to a block page.
var venueProbes = []venueProbe{
	{
		Venue: "polymarket",
		URL:   "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=1",
	},
	{
		Venue: "kalshi",
		URL:   "https://api.elections.kalshi.com/trade-api/v2/markets/?limit=1",
	},
	{
		Venue: "limitless",
		URL:   "https://api.limitless.exchange/markets/active?page=1&limit=1&sortBy=newest",
	},
	{
		Venue: "manifold",
		URL:   "https://api.manifold.markets/v0/markets?limit=1",
	},
	{
		Venue: "myriad",
		URL:   "https://api-v2.myriadprotocol.com/markets?state=open&limit=1",
	},
}

var httpClientProbe = &http.Client{
	Timeout: probeTimeout,
	// Follow redirects but detect block pages (redirect to geo-block URL).
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

// runAllProbes fires one HTTP GET per venue and updates the accessibility gauge.
func runAllProbes(region string) {
	for _, p := range venueProbes {
		runProbe(p, region)
	}
}

func runProbe(p venueProbe, region string) {
	pmGeoProbeTotal.WithLabelValues(p.Venue, region).Inc()

	req, err := http.NewRequest("GET", p.URL, nil)
	if err != nil {
		pmGeoAccessible.WithLabelValues(p.Venue, region).Set(0)
		pmGeoFetchErrors.WithLabelValues(p.Venue, "request_build").Inc()
		return
	}
	req.Header.Set("User-Agent", probeUA)
	req.Header.Set("Accept", "application/json")

	resp, err := httpClientProbe.Do(req)
	if err != nil {
		pmGeoAccessible.WithLabelValues(p.Venue, region).Set(0)
		pmGeoLastRefresh.WithLabelValues(p.Venue, region).Set(float64(time.Now().Unix()))
		pmGeoFetchErrors.WithLabelValues(p.Venue, "network").Inc()
		fmt.Printf("[geo][%s][%s] network error: %v\n", p.Venue, region, err)
		return
	}
	defer resp.Body.Close()
	// Drain body to reuse connection.
	_, _ = io.Copy(io.Discard, resp.Body)

	accessible := 0.0
	if resp.StatusCode == 200 {
		accessible = 1.0
	}

	pmGeoAccessible.WithLabelValues(p.Venue, region).Set(accessible)
	pmGeoLastRefresh.WithLabelValues(p.Venue, region).Set(float64(time.Now().Unix()))

	fmt.Printf("[geo][%s][%s] status=%d accessible=%.0f\n",
		p.Venue, region, resp.StatusCode, accessible)
}
