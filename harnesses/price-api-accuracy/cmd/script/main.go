// price-api-accuracy: OpenChainBench bench 305.
//
// Polls the USD price that crypto market-data APIs publish for the same
// majors, and scores every answer against the exchange mid of the same
// moment: the median of Coinbase (USD), Kraken (USD) and Binance (USDT,
// converted to USD at Kraken's USDT/USD mid). The published figure is the
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

	for _, p := range providers(cfg) {
		if !p.enabled {
			log.Printf("provider %s disabled: %s", p.slug, p.disabledReason)
			continue
		}
		pollInterval.WithLabelValues(p.slug).Set(p.interval.Seconds())
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

func runProvider(ctx context.Context, p provider, ref *reference) {
	// Stagger the first poll so seven providers do not fire on the same
	// reference tick at boot.
	select {
	case <-ctx.Done():
		return
	case <-time.After(p.startDelay):
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
		requests.WithLabelValues(p.slug, status).Inc()
		for _, a := range p.assets {
			assetPolls.WithLabelValues(p.slug, strings.ToLower(a), "failed").Inc()
		}
		log.Printf("%s: %s: %v", p.slug, status, err)
		return
	}
	requests.WithLabelValues(p.slug, "ok").Inc()

	snap, ok := ref.at(got)
	for _, a := range p.assets {
		q, served := quotes[a]
		al := strings.ToLower(a)
		if !served || !(q.price > 0) {
			assetPolls.WithLabelValues(p.slug, al, "missing").Inc()
			continue
		}
		price.WithLabelValues(p.slug, al).Set(q.price)
		if !q.ts.IsZero() {
			age := got.Sub(q.ts).Seconds()
			if age < 0 {
				age = 0
			}
			priceAge.WithLabelValues(p.slug, al).Set(age)
		}
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

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
