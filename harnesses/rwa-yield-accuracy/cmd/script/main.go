package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
)

// probes is the V1 cohort. Each entry declares one (issuer, token,
// chain) triple with its own on-chain read logic. Adding a token to
// this bench is: (1) implement IssuerProbe, (2) add its slug to
// promised-yields.yml, (3) append here.
//
// Active cohort:
//   - USDY (Ondo, rebase)
//   - USTB (Superstate, Chainlink NAV feed)
//   - OUSG (Ondo, OndoOracle IPriceOracle)
//   - SyrupUSDC (Maple, ERC-4626 convertToAssets)
//
// BUIDL and BENJI dormant: distributor mints conflate yield with
// subscriptions (BUIDL), Ethereum wrapper lacks on-chain NAV (BENJI).
var probes = []IssuerProbe{
	NewUSDYProbe(),
	NewUSTBProbe(),
	NewOUSGProbe(),
	NewSyrupUSDCProbe(),
	// NewBUIDLProbe(),  // TODO: split bulkIssuance mints from subscriptions
	// NewBENJIProbe(),  // TODO: waiting Franklin NAV endpoint confirmation
}

// rpcHost is the RPC URL's host only: a keyed URL must never reach the
// container log or the /logs ring.
func rpcHost() string {
	if u, err := url.Parse(rpcURL()); err == nil && u.Host != "" {
		return u.Host
	}
	return "(unparsed)"
}

// scrubURL replaces the RPC URL (which go-ethereum's *url.Error text
// repeats, key included) with its host before a message is logged.
func scrubURL(msg string) string {
	full := rpcURL()
	if full == "" {
		return msg
	}
	return strings.ReplaceAll(msg, full, rpcHost())
}

func main() {
	installLogCapture()
	fmt.Println("=== RWA Yield Accuracy Harness ===")
	fmt.Println("OpenChainBench № 089 - on-chain delivered yield vs advertised APY.")
	fmt.Printf("Cohort: %d tokens | RPC host: %s\n", len(probes), rpcHost())
	for _, p := range probes {
		fmt.Printf("  - %s/%s on %s\n", p.Issuer(), p.Slug(), p.Chain())
	}
	fmt.Println()

	// Promised-yield store: loaded from disk, hot-reloaded so a manual
	// weekly edit lands within a scrape cycle.
	promised := newPromisedStore(promisedYieldsPath())
	if err := promised.reload(); err != nil {
		fmt.Printf("[fatal] load %s: %v\n", promisedYieldsPath(), err)
		os.Exit(1)
	}
	fmt.Printf("Promised yields loaded from %s\n", promisedYieldsPath())

	// Ethereum RPC client. All V1 probes share one client since they
	// all read from Ethereum mainnet. V2 will introduce per-chain
	// clients (USDY on Solana, BUIDL on Arbitrum, etc.).
	rpc, err := ethclient.Dial(rpcURL())
	if err != nil {
		fmt.Printf("[fatal] rpc dial: %s\n", scrubURL(err.Error()))
		os.Exit(1)
	}
	defer rpc.Close()

	// Metrics server: /metrics, /health, /logs on :2112.
	go func() {
		if err := StartMetricsServer(listenAddr()); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()
	fmt.Printf("Metrics server: %s/metrics\n\n", listenAddr())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Concurrent measurement loop. One goroutine per probe. Each
	// probe polls at pollInterval, writes to Prometheus directly (no
	// central aggregator) so a failure on one token can't stall the
	// others.
	var wg sync.WaitGroup
	for _, probe := range probes {
		probe := probe
		wg.Add(1)
		go func() {
			defer wg.Done()
			runProbe(ctx, probe, rpc, promised)
		}()
	}

	// Config file reloader: refreshes promised-yields.yml so a manual
	// weekly edit propagates without a redeploy.
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(promisedReloadInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := promised.reload(); err != nil {
					fmt.Printf("[promised] reload failed: %v\n", err)
				}
			}
		}
	}()

	// Graceful shutdown on SIGINT / SIGTERM.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
	wg.Wait()
}

// runProbe is the per-token measurement loop. It polls, writes the
// resulting Measurement into Prometheus, and cross-references the
// promised APY (from the hot-reloaded config) to emit the deviation
// gauge. A failed probe increments the error counter and marks the
// token unhealthy but does NOT touch the delivered / promised gauges,
// so a transient RPC hiccup can't flip a healthy row to zero.
func runProbe(ctx context.Context, probe IssuerProbe, rpc *ethclient.Client, promised *promisedStore) {
	labels := []string{probe.Issuer(), probe.Slug(), probe.Chain()}
	var last *Measurement

	// tick returns true when a measurement landed. A failure keeps the
	// last good measurement published and probe_ok at 1 while that
	// measurement is under staleAfter old: one failed archive call among
	// about 76 must not blank the row for an hour (review 2026-09-23).
	tick := func() bool {
		probeCtx, cancel := context.WithTimeout(ctx, measureTimeout)
		defer cancel()

		m, err := probe.Measure(probeCtx, rpc)
		if err != nil {
			classifyAndCount(probe, err)
			if last == nil || time.Since(last.MeasuredAt) > staleAfter {
				probeOK.WithLabelValues(labels...).Set(0)
			}
			fmt.Printf("[%s] probe error: %s\n", probe.Slug(), scrubURL(err.Error()))
			return false
		}

		// Delivered yields (always emitted, even if promised is missing).
		deliveredBps30d.WithLabelValues(labels...).Set(float64(m.DeliveredBps30d))
		deliveredBps7d.WithLabelValues(labels...).Set(float64(m.DeliveredBps7d))
		if m.SpanDays30d > 0 {
			windowDays30d.WithLabelValues(labels...).Set(m.SpanDays30d)
			windowDays7d.WithLabelValues(labels...).Set(m.SpanDays7d)
		}
		deliveredBpsLifetime.WithLabelValues(labels...).Set(float64(m.DeliveredBpsLifetime))

		// Supply / AUM context.
		totalSupply.WithLabelValues(labels...).Set(m.TotalSupplyUnits)
		aumUSD.WithLabelValues(labels...).Set(m.AUMUSD)

		// Distributions counter (dividend-model tokens only).
		if m.NewDistributionsUSD > 0 {
			distributionsUSD.WithLabelValues(labels...).Add(m.NewDistributionsUSD)
		}

		// Deviation vs promised (skipped if promised is missing for
		// this token — the delivered_bps series still tells the story).
		if promisedBpsVal, ok := promised.get(probe.Slug()); ok {
			promisedBps.WithLabelValues(labels...).Set(float64(promisedBpsVal))
			deviationBps30d.WithLabelValues(labels...).Set(float64(m.DeliveredBps30d - promisedBpsVal))
			deviationBps7d.WithLabelValues(labels...).Set(float64(m.DeliveredBps7d - promisedBpsVal))
			deviationBpsLifetime.WithLabelValues(labels...).Set(float64(m.DeliveredBpsLifetime - promisedBpsVal))
		}

		probeOK.WithLabelValues(labels...).Set(1)
		lastMeasured.WithLabelValues(labels...).Set(float64(m.MeasuredAt.Unix()))
		last = m

		fmt.Printf("[%s] delivered_30d=%d bps 7d=%d bps supply=%s AUM=%s\n",
			probe.Slug(),
			m.DeliveredBps30d,
			m.DeliveredBps7d,
			shortNum(m.TotalSupplyUnits),
			shortNum(m.AUMUSD),
		)
		return true
	}

	// The measurement (two print searches per window, a few dozen archive
	// calls) runs hourly, as the spec says; the deviation against the
	// hot-reloaded reference APY is republished every minute from the
	// last measurement, so a config edit lands within a scrape.
	// Until a measurement succeeds, retry every pollInterval; then hourly.
	ok := tick()
	nextMeasure := time.Now().Add(pollInterval)
	if ok {
		nextMeasure = time.Now().Add(windowRecomputeInterval)
	}
	republish := time.NewTicker(pollInterval)
	defer republish.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-republish.C:
			if time.Now().After(nextMeasure) {
				if tick() {
					nextMeasure = time.Now().Add(windowRecomputeInterval)
				} else {
					nextMeasure = time.Now().Add(pollInterval)
				}
			}
			if last != nil {
				if promisedBpsVal, ok := promised.get(probe.Slug()); ok {
					promisedBps.WithLabelValues(labels...).Set(float64(promisedBpsVal))
					deviationBps30d.WithLabelValues(labels...).Set(float64(last.DeliveredBps30d - promisedBpsVal))
					deviationBps7d.WithLabelValues(labels...).Set(float64(last.DeliveredBps7d - promisedBpsVal))
					deviationBpsLifetime.WithLabelValues(labels...).Set(float64(last.DeliveredBpsLifetime - promisedBpsVal))
				}
			}
		}
	}
}

// classifyAndCount buckets probe errors so the error_type dimension
// stays low-cardinality. Anything that doesn't match a known bucket
// falls into "other".
func classifyAndCount(probe IssuerProbe, err error) {
	msg := err.Error()
	bucket := "other"
	switch {
	case contains(msg, "context deadline"), contains(msg, "timeout"):
		bucket = "timeout"
	case contains(msg, "connection refused"), contains(msg, "dial"), contains(msg, "EOF"):
		bucket = "rpc_err"
	case contains(msg, "empty call result"), contains(msg, "invalid opcode"):
		bucket = "contract_err"
	case contains(msg, "parse"), contains(msg, "unmarshal"):
		bucket = "parse_err"
	case contains(msg, "nav source"), contains(msg, "issuer api"):
		bucket = "nav_source_err"
	}
	probeErrors.WithLabelValues(probe.Issuer(), probe.Slug(), probe.Chain(), bucket).Inc()
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// shortNum formats a large number as e.g. "534.2M" for logging.
func shortNum(n float64) string {
	switch {
	case n >= 1e9:
		return fmt.Sprintf("%sB", strconv.FormatFloat(n/1e9, 'f', 2, 64))
	case n >= 1e6:
		return fmt.Sprintf("%sM", strconv.FormatFloat(n/1e6, 'f', 2, 64))
	case n >= 1e3:
		return fmt.Sprintf("%sK", strconv.FormatFloat(n/1e3, 'f', 2, 64))
	default:
		return strconv.FormatFloat(n, 'f', 2, 64)
	}
}
