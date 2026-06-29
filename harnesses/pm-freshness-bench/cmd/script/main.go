package main

import (
	"context"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

var correlator = NewCorrelator()

func main() {
	cfg := loadConfig()
	appendLog("[boot] pm-freshness-bench starting (basket=%d, refresh=%ds)", cfg.BasketSize, cfg.RefreshMarketsIntervalSec)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		appendLog("[boot] shutdown signal received")
		cancel()
	}()

	// fan-out: every Polymarket basket refresh broadcasts on these per-consumer channels.
	polyCh := make(chan []Market, 4)
	codexPolyCh := make(chan []Market, 4)
	mobulaCh := make(chan []Market, 4)
	onChange := func(ms []Market) {
		for _, ch := range []chan []Market{polyCh, codexPolyCh, mobulaCh} {
			select {
			case ch <- ms:
			default:
				// channel full — provider will pick up the change on the next refresh
			}
		}
	}

	// Kalshi has its own basket which is now built dynamically by the
	// Kalshi T0 client itself from the global /v1/social/trades feed. The
	// /trade-api/v2/markets endpoint returns zero volume on every row so
	// the previous markets-based refresh produced a basket of random
	// inactive series; the observation-based basket auto-targets the
	// active markets instead.
	codexKalshiCh := make(chan []Market, 4)

	// health gauges decay: any (provider, venue) pair that hasn't published in 60s drops to 0.
	go healthDecayLoop(ctx)

	var wg sync.WaitGroup
	wg.Add(5)
	go func() {
		defer wg.Done()
		refreshLoop(ctx, time.Duration(cfg.RefreshMarketsIntervalSec)*time.Second, cfg.BasketSize, onChange)
	}()
	go func() { defer wg.Done(); runPolymarket(ctx, polyCh) }()
	go func() { defer wg.Done(); runCodex(ctx, cfg, codexPolyCh, codexKalshiCh) }()
	go func() { defer wg.Done(); runMobula(ctx, cfg, mobulaCh) }()
	go func() { defer wg.Done(); runKalshi(ctx, cfg, codexKalshiCh) }()

	// :2112 hardcoded per the OCB convention — Railway $PORT is intentionally ignored
	// so the shared Prom can scrape every harness on the same well-known port.
	go func() {
		if err := startMetricsServer(":2112", cfg.LogsToken); err != nil {
			appendLog("[metrics] server err: %v", err)
		}
	}()

	wg.Wait()
}

// lastEventAt is updated by every WS client when it observes a real event,
// keyed by (provider, venue). The decay loop reads it and drops the
// corresponding health gauge to 0 when nothing has arrived in the last 60s.
type provVenue struct{ provider, venue string }

var (
	lastEventMu sync.Mutex
	lastEventAt = map[provVenue]time.Time{}
)

// healthPairs is the static list of (provider, venue) tuples we track.
// Polymarket venue: 3 providers (polymarket T0, codex follower, mobula follower).
// Kalshi venue:     2 providers (kalshi T0, codex follower).
var healthPairs = []provVenue{
	{"polymarket", "polymarket"},
	{"codex", "polymarket"},
	{"mobula", "polymarket"},
	{"kalshi", "kalshi"},
	{"codex", "kalshi"},
}

func markAlive(provider, venue string) {
	lastEventMu.Lock()
	lastEventAt[provVenue{provider, venue}] = time.Now()
	lastEventMu.Unlock()
}

func healthDecayLoop(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			lastEventMu.Lock()
			for _, pv := range healthPairs {
				last, ok := lastEventAt[pv]
				if !ok || time.Since(last) > 60*time.Second {
					health.WithLabelValues(pv.provider, pv.venue).Set(0)
				}
			}
			lastEventMu.Unlock()
		}
	}
}

func classify(err error) string {
	if err == nil {
		return "none"
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "429") || strings.Contains(s, "rate limited"):
		return "rate_limit"
	case strings.Contains(s, "401") || strings.Contains(s, "403") || strings.Contains(s, "4403") || strings.Contains(s, "auth"):
		return "auth"
	case strings.Contains(s, "timeout"):
		return "timeout"
	case strings.Contains(s, "eof") || strings.Contains(s, "reset"):
		return "conn_drop"
	default:
		return "other"
	}
}
