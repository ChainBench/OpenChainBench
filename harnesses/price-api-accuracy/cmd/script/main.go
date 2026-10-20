// price-api-accuracy: OpenChainBench bench 305.
//
// Polls the USD price that crypto market-data APIs publish for the same
// majors, and scores every answer against the exchange mid of the same
// moment: the median of Coinbase (USD), Kraken (USD) and Binance (USDT,
// converted to USD at the Coinbase/Kraken USDT/USD mid). The published figure is the
// absolute gap in basis points.
//
// Each provider is polled on its own cadence, set by what its free or
// assigned quota allows. The gap is measured against the reference snapshot
// nearest the moment the answer arrived, so a provider polled every five
// minutes is scored on the same footing as one polled every thirty seconds:
// fewer samples, the same distribution.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg := loadConfig()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ref := newReference(cfg)
	go ref.run(ctx)

	enabled := []provider{}
	for _, p := range providers(cfg) {
		if !p.enabled {
			log.Printf("provider %s disabled: %s", p.slug, p.disabledReason)
			continue
		}
		pollInterval.WithLabelValues(p.slug).Set(p.interval.Seconds())
		initSeries(p)
		enabled = append(enabled, p)
	}
	for _, p := range enabled {
		go runProvider(ctx, p, ref)
	}

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	srv := &http.Server{Addr: cfg.listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Printf("price-api-accuracy listening on %s", cfg.listen)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// firstPollAfter holds every first poll past one scrape interval (30 s on
// the OCB Prometheus). The counters and histograms are created at zero in
// initSeries, so Prometheus scrapes the zero first and the first answer
// after a restart reads as an increase from it. Without both, a series born
// with its first observation shows no increase until the second, and a
// restart that lands a bucket back on its old value hides a reset: the
// first deploys published a CoinPaprika median resting on zero samples.
const firstPollAfter = 45 * time.Second

// initSeries creates every (provider, asset) child at zero before any poll.
func initSeries(p provider) {
	requests.WithLabelValues(p.slug, "ok").Add(0)
	for _, a := range p.assets {
		al := strings.ToLower(a)
		deviation.WithLabelValues(p.slug, al)
		for _, st := range []string{"ok", "missing", "failed", "no_reference", "probe_error"} {
			assetPolls.WithLabelValues(p.slug, al, st).Add(0)
		}
	}
}

func runProvider(ctx context.Context, p provider, ref *reference) {
	// Past the first scrape, then staggered so the providers do not fire
	// on the same reference tick.
	select {
	case <-ctx.Done():
		return
	case <-time.After(firstPollAfter + p.startDelay):
	}
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		pollOnce(ctx, p, ref)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func pollOnce(ctx context.Context, p provider, ref *reference) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	quotes, err := p.fetch(cctx)
	got := time.Now()
	if err != nil {
		status := classify(err)
		var counted countedError
		if !errors.As(err, &counted) {
			requests.WithLabelValues(p.slug, status).Inc()
		}
		// Through the proxy, an answer that never arrived (no HTTP status)
		// is lost on our side of the wire and must not read as the
		// provider failing. An HTTP status, 429 included, is the provider's.
		pollStatus := "failed"
		var hs httpStatusError
		if p.viaProxy && !errors.As(err, &hs) {
			pollStatus = "probe_error"
		}
		for _, a := range p.assets {
			al := strings.ToLower(a)
			assetPolls.WithLabelValues(p.slug, al, pollStatus).Inc()
			forgetLast(p.slug, al)
		}
		log.Printf("%s: %s: %v", p.slug, status, err)
		return
	}
	requests.WithLabelValues(p.slug, "ok").Inc()

	for _, a := range p.assets {
		q, served := quotes[a]
		al := strings.ToLower(a)
		if !served || !(q.price > 0) {
			assetPolls.WithLabelValues(p.slug, al, "missing").Inc()
			forgetLast(p.slug, al)
			continue
		}
		arrived := got
		if !q.at.IsZero() {
			arrived = q.at
		}
		price.WithLabelValues(p.slug, al).Set(q.price)
		if !q.ts.IsZero() {
			age := arrived.Sub(q.ts).Seconds()
			if age < 0 {
				age = 0
			}
			priceAge.WithLabelValues(p.slug, al).Set(age)
		}
		snap, ok := ref.at(arrived)
		mid, haveMid := snap.mids[a]
		if !ok || !haveMid {
			// No reference close enough in time to score against. Counted
			// apart so a reference outage never reads as a provider failure.
			assetPolls.WithLabelValues(p.slug, al, "no_reference").Inc()
			continue
		}
		bps := (q.price/mid - 1) * 1e4
		deviation.WithLabelValues(p.slug, al).Observe(abs(bps))
		signedDeviation.WithLabelValues(p.slug, al).Set(bps)
		assetPolls.WithLabelValues(p.slug, al, "ok").Inc()
	}
}

// forgetLast drops the last-value gauges of a (provider, asset) the moment a
// poll yields no price for it. A gauge otherwise keeps its last value for as
// long as the process lives, and a provider whose key was revoked would go
// on printing a bias and a price age on the page for a whole 24h window.
func forgetLast(provider, asset string) {
	signedDeviation.DeleteLabelValues(provider, asset)
	priceAge.DeleteLabelValues(provider, asset)
	price.DeleteLabelValues(provider, asset)
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
