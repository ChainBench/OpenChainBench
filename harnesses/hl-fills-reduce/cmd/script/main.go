// hl-fills-reduce -- turns the Hyperliquid node's hourly fill stream into
// per-builder daily totals, and serves them to the hyperliquid-frontends
// harness.
//
// Why this exists. The public per-builder export at
// stats-data.hyperliquid.xyz cuts most days off at roughly 12:10 UTC, so a
// 30-day total built from it lands near half the real figure. Measured on
// fomo for 2026-10-06: the export carried $53.1M of notional and $25,288 of
// builder fees, and the node's own fill stream for the same day carries
// $192.5M and $93,131. CoinMarketMan, reading a complete feed, reported
// $93.1K for that day. The node agrees with them to within 4%; the export
// does not, and no arithmetic on a half day recovers the other half.
//
// The node writes the whole day because it is the one applying the blocks.
// `--write-fills` puts every fill under
// <data>/node_fills_by_block/hourly/<YYYYMMDD>/<hour>, one JSON object per
// block, and each fill carries the builder address alongside the builder fee.
// That is the complete source, and this reduces it to something small enough
// to ship: 104 builders a day instead of four gigabytes.
//
// What it is not: a second opinion. Where a day is present here it replaces
// the export for that day rather than being averaged with it. Two
// measurements of the same thing that disagree by a factor of two are not two
// measurements.
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

const (
	defaultAddr     = "127.0.0.1:2115"
	defaultFillsDir = "/mnt/hyperliquid/data/node_fills_by_block/hourly"
	defaultOutDir   = "/mnt/hyperliquid/ocb-fills-daily"
	// A day is reduced only once it can no longer change. The node writes
	// hour N's file when hour N ends, so a day is final shortly after 00:00
	// the next day; the margin absorbs a slow flush and a restart.
	settleAfterMidnight = 90 * time.Minute
)

func main() {
	var (
		addr     = flag.String("addr", envOr("HL_REDUCE_ADDR", defaultAddr), "metrics and data listen address")
		fillsDir = flag.String("fills", envOr("HL_REDUCE_FILLS", defaultFillsDir), "node hourly fills directory")
		outDir   = flag.String("out", envOr("HL_REDUCE_OUT", defaultOutDir), "where reduced days are written")
		mount    = flag.String("mount", envOr("HL_REDUCE_MOUNT", "/mnt/hyperliquid"), "filesystem to report free space for")
		every    = flag.Duration("every", 30*time.Minute, "how often to look for days to reduce")
		once     = flag.Bool("once", false, "reduce everything pending and exit")
		backfill = flag.Int("backfill", 45, "how many days back to consider")
	)
	flag.Parse()

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatalf("out dir: %v", err)
	}

	r := &Reducer{
		FillsDir: *fillsDir,
		OutDir:   *outDir,
		Mount:    *mount,
		Backfill: *backfill,
	}

	if *once {
		n, err := r.Sweep()
		if err != nil {
			log.Fatalf("sweep: %v", err)
		}
		log.Printf("reduced %d day(s)", n)
		return
	}

	go func() {
		log.Printf("serving on %s", *addr)
		if err := serve(*addr, r); err != nil {
			log.Fatalf("serve: %v", err)
		}
	}()

	if n, err := r.Sweep(); err != nil {
		log.Printf("sweep: %v", err)
	} else {
		log.Printf("reduced %d day(s)", n)
	}

	t := time.NewTicker(*every)
	defer t.Stop()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	for {
		select {
		case <-t.C:
			if n, err := r.Sweep(); err != nil {
				log.Printf("sweep: %v", err)
			} else if n > 0 {
				log.Printf("reduced %d day(s)", n)
			}
		case <-stop:
			log.Printf("shutting down")
			return
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func dayPath(dir, day string) string { return filepath.Join(dir, day) }
