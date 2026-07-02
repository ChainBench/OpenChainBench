package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// buildMarker is bumped manually on every commit that ships a Codex
// providers behavior change so the runtime log proves which version is
// actually deployed. Increment on every release.
const buildMarker = "codex-fix-v6-canonical-id-discovery"

func main() {
	installLogCapture()
	log.SetFlags(0)
	log.Printf("[pm-rate-limits] starting, region=%s ramp_hour=%02d:00 UTC build=%s", currentRegion, rampHour(), buildMarker)

	cfg := loadConfig()

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			log.Printf("[pm-rate-limits] metrics server died: %v", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pinClient := &http.Client{Timeout: 20 * time.Second}
	vs := venues()
	stateByVenue := map[string]*venueState{}
	for _, v := range vs {
		v.state = newVenueState()
		stateByVenue[v.Slug] = v.state
		go initialPin(ctx, v, pinClient)
		go repinLoop(ctx, v, v.state, pinClient)
		warmClient := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 4, IdleConnTimeout: 90 * time.Second}}
		for _, cl := range v.Classes {
			go warmLoop(ctx, v, cl, v.state, warmClient)
		}
		go coldLoop(ctx, v, v.state)
		if v.Slug == "polymarket" {
			go runPolymarketWS(ctx, v.state)
		}
	}

	// Aggregator probes. One goroutine per (venue, source) pair; reuses
	// the venueState pin so the apples-to-apples comparison holds.
	aggClient := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 4, IdleConnTimeout: 90 * time.Second}}

	// One-shot Codex discovery: filterPredictionMarkets on Polymarket so
	// we see the canonical composite marketId Codex stores. Without this
	// we are guessing exchange address and tokenId encoding.
	if cfg.DefinedSessionCookie != "" {
		go codexDiscoveryProbe(cfg.DefinedSessionCookie, aggClient)
	}

	for _, ps := range aggregatorProbes(cfg) {
		st, ok := stateByVenue[ps.Venue]
		if !ok {
			log.Printf("[providers] no venueState for %s/%s — skipping", ps.Venue, ps.Source)
			continue
		}
		log.Printf("[providers] enabled %s/%s every %s", ps.Source, ps.Venue, ps.Interval)
		go aggregatorLoop(ctx, ps, st, aggClient)
	}

	go dailyRepin(ctx, vs, pinClient)
	go rampLoop(ctx, vs)

	<-ctx.Done()
	log.Printf("[pm-rate-limits] shutting down")
}

func initialPin(ctx context.Context, v *Venue, client *http.Client) {
	for ctx.Err() == nil {
		pin, err := v.PinFunc(ctx, client, "")
		if err == nil {
			v.state.setPin(pin)
			log.Printf("[pin][%s] pinned %q (expiry %s)", v.Slug, pin.Market, pin.Expiry.Format(time.RFC3339))
			return
		}
		log.Printf("[pin][%s] initial pin failed: %v (retry in 30s)", v.Slug, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
}

// dailyRepin refreshes every venue's pinned market at 00:00 UTC so the target
// stays the liquid near-the-money market of the day. Failures keep the old
// pin; probe_invalid handling covers intraday resolutions.
func dailyRepin(ctx context.Context, vs []*Venue, client *http.Client) {
	for {
		now := time.Now().UTC()
		next := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Until(next)):
		}
		for _, v := range vs {
			pin, err := v.PinFunc(ctx, client, "")
			if err != nil {
				log.Printf("[pin][%s] daily re-pin failed, keeping %q: %v", v.Slug, v.state.getPin().Market, err)
				continue
			}
			v.state.setPin(pin)
			log.Printf("[pin][%s] daily re-pin -> %q (expiry %s)", v.Slug, pin.Market, pin.Expiry.Format(time.RFC3339))
		}
	}
}
