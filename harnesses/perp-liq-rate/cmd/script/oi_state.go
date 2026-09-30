package main

// oi_state.go: the open-interest window, kept across restarts.
//
// The denominator of perp_liq_rate_24h_pct is the peak open interest over the
// trailing 24 hours, and open interest is the one input here that cannot be
// backfilled: every liquidation source reads its own history on the first
// tick, but no venue publishes a minute-by-minute record of the book it used
// to hold. So a restart used to leave the window holding whatever it had
// gathered since boot, and the rate divided a full 24h numerator by the peak
// of that short span.
//
// That is not a small error. On 2026-09-28, an hour after a redeploy, Gains
// ETH published 952% and BTC 211%: the numerator was the whole cascade and
// the denominator was the peak of the quiet hour that followed it, 2.9M
// dollars against a book that had been 43.7M inside the window. The figures
// were each read correctly and the rate was nonsense, for the same reason the
// instantaneous and mean denominators were before it.
//
// It also blanked the board for an hour after every deploy, four times in one
// afternoon, which on a longer window would be a longer blackout.
//
// So the samples live in a small JSON file, the shape harnesses/
// protocol-valuation uses for its fee-basis memory: read on boot, written
// after each tick, and entirely optional. Without a writable path the harness
// runs exactly as it did before and forgets on restart, which is the state
// this file improves on rather than a failure to report.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// oiSample is one open-interest reading as it sits on disk.
type oiSample struct {
	TsMs  int64   `json:"t"`
	Value float64 `json:"v"`
}

// liqEntry is one liquidation as it sits on disk. The key matters as much as
// the amount: it goes back into the SeenSet so a source that re-reports the
// same event after a restart does not add it twice.
type liqEntry struct {
	Key        string  `json:"k"`
	TsMs       int64   `json:"t"`
	Notional   float64 `json:"n"`
	Collateral float64 `json:"c,omitempty"`
	Leverage   float64 `json:"l,omitempty"`
	// HasForfeit and the two figures under it carry the forfeited-collateral
	// arithmetic across a restart. The flag is written even though it is
	// implied by nothing else, because a returned amount of zero is the
	// normal reading on Gains and Ostium and must not come back as "the
	// source never said".
	HasForfeit  bool    `json:"f,omitempty"`
	LossPct     float64 `json:"lp,omitempty"`
	ReturnedUSD float64 `json:"r,omitempty"`
	// The itemised fee part of the forfeit, where the feed splits it, under its
	// own flag for the same reason as HasForfeit: a fee share of zero is a real
	// reading on GMX's smallest positions.
	HasFeeSplit    bool    `json:"fs,omitempty"`
	FeeAndCarryUSD float64 `json:"fc,omitempty"`
}

// oiStateFile is the whole file: both windows of every pair, keyed
// "venue/asset", plus when it was written so a stale file can be judged.
type oiStateFile struct {
	SavedAtMs int64                 `json:"saved_at_ms"`
	Windows   map[string][]oiSample `json:"windows"`
	Liq       map[string][]liqEntry `json:"liq,omitempty"`
	NoDetail  map[string]bool       `json:"no_event_detail,omitempty"`
}

// oiStateStore reads and writes the open-interest windows.
type oiStateStore struct {
	mu       sync.Mutex
	path     string
	onDisk   map[string][]oiSample
	liq      map[string][]liqEntry
	noDetail map[string]bool
	warned   bool // a write failed once; do not repeat the log every tick
}

func oiStateKey(venue, asset string) string { return venue + "/" + asset }

// newOIStateStore loads the file if there is one. A missing, unreadable or
// unparseable file starts an empty store and says so once.
func newOIStateStore(path string) *oiStateStore {
	s := &oiStateStore{path: path, onDisk: map[string][]oiSample{},
		liq: map[string][]liqEntry{}, noDetail: map[string]bool{}}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[oi-state] cannot read %s: %v (starting empty)", path, err)
		}
		return s
	}
	var f oiStateFile
	if err := json.Unmarshal(b, &f); err != nil {
		log.Printf("[oi-state] %s is not readable json: %v (starting empty)", path, err)
		return s
	}
	if f.Windows != nil {
		s.onDisk = f.Windows
	}
	if f.Liq != nil {
		s.liq = f.Liq
	}
	if f.NoDetail != nil {
		s.noDetail = f.NoDetail
	}
	return s
}

// restore puts the saved readings back into a pair's window, dropping any
// that have aged out while the harness was down. Reports how many landed.
func (s *oiStateStore) restore(venue, asset string, w *SampleWindow, nowMs int64) int {
	s.mu.Lock()
	saved := s.onDisk[oiStateKey(venue, asset)]
	s.mu.Unlock()
	if len(saved) == 0 {
		return 0
	}
	cutoff := nowMs - windowSpan.Milliseconds()
	n := 0
	for _, e := range saved {
		if e.TsMs < cutoff || e.TsMs > nowMs || e.Value <= 0 {
			continue
		}
		w.Add(e.TsMs, e.Value)
		n++
	}
	return n
}

// restoreLiq puts the saved liquidations back into a pair's window and marks
// their keys seen, so a source that re-reports them cannot double count. A
// bucket source restates by key anyway, so this is safe for both kinds.
func (s *oiStateStore) restoreLiq(venue, asset string, st *pairState, nowMs int64) int {
	key := oiStateKey(venue, asset)
	s.mu.Lock()
	saved := s.liq[key]
	noDetail := s.noDetail[key]
	s.mu.Unlock()
	if noDetail {
		st.noEventDetail = true
	}
	if len(saved) == 0 {
		return 0
	}
	cutoff := nowMs - windowSpan.Milliseconds()
	n := 0
	for _, e := range saved {
		if e.Key == "" || e.TsMs < cutoff || e.TsMs > nowMs || e.Notional <= 0 {
			continue
		}
		st.seen.Add(e.Key, e.TsMs)
		st.window.AddEvent(LiqEvent{Key: e.Key, TimestampMs: e.TsMs, NotionalUSD: e.Notional,
			CollateralUSD: e.Collateral, Leverage: e.Leverage,
			HasForfeitDetail: e.HasForfeit, LossAtTriggerPct: e.LossPct, ReturnedUSD: e.ReturnedUSD,
			HasFeeSplit: e.HasFeeSplit, FeeAndCarryUSD: e.FeeAndCarryUSD})
		n++
	}
	return n
}

// save writes every pair's current window. Called after a tick, so a restart
// resumes from at most one tick ago.
func (s *oiStateStore) save(pairs []*pairRuntime, now time.Time) {
	if s.path == "" {
		return
	}
	f := oiStateFile{SavedAtMs: now.UnixMilli(),
		Windows:  make(map[string][]oiSample, len(pairs)),
		Liq:      make(map[string][]liqEntry, len(pairs)),
		NoDetail: make(map[string]bool, len(pairs)),
	}
	for _, p := range pairs {
		key := oiStateKey(p.va.Venue, p.va.Asset)
		if samples := p.st.oi.Samples(); len(samples) > 0 {
			out := make([]oiSample, 0, len(samples))
			for _, e := range samples {
				out = append(out, oiSample{TsMs: e.tsMs, Value: e.notional})
			}
			f.Windows[key] = out
		}
		if entries := p.st.window.Entries(); len(entries) > 0 {
			out := make([]liqEntry, 0, len(entries))
			for _, e := range entries {
				out = append(out, liqEntry{Key: e.key, TsMs: e.tsMs, Notional: e.notional,
					Collateral: e.collateral, Leverage: e.leverage,
					HasForfeit: e.hasForfeit, LossPct: e.lossPct, ReturnedUSD: e.returnedUSD,
					HasFeeSplit: e.hasFeeSplit, FeeAndCarryUSD: e.feeAndCarryUSD})
			}
			f.Liq[key] = out
		}
		if p.st.noEventDetail {
			f.NoDetail[key] = true
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.onDisk, s.liq, s.noDetail = f.Windows, f.Liq, f.NoDetail
	b, err := json.Marshal(f)
	if err != nil {
		s.warnOnce("encode: %v", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		s.warnOnce("cannot create %s: %v", filepath.Dir(s.path), err)
		return
	}
	// Write and rename, so a crash mid-write cannot leave a half file that
	// the next boot then refuses to parse.
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		s.warnOnce("cannot write %s: %v", tmp, err)
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		s.warnOnce("cannot replace %s: %v", s.path, err)
		return
	}
}

// warnOnce logs the first failure and stays quiet after that: an unwritable
// path is a degraded mode, not a reason to fill the log every five minutes.
func (s *oiStateStore) warnOnce(format string, args ...any) {
	if s.warned {
		return
	}
	s.warned = true
	log.Printf("[oi-state] "+format+" (the window will not survive a restart)", args...)
}

// spansWindow reports whether the readings held cover the span the numerator
// covers, within one tick. Until they do, the peak is the peak of a shorter
// period and a rate built on it is not the 24h rate its name claims.
func oiSpansWindow(w *SampleWindow, nowMs int64, tick time.Duration) bool {
	oldest, _, n := w.Bounds()
	if n < minOISamples || oldest == 0 {
		return false
	}
	return nowMs-oldest >= windowSpan.Milliseconds()-2*tick.Milliseconds()
}

// fmtStateSummary is used in the boot log so an operator can see at a glance
// whether the window came back.
func fmtStateSummary(restored map[string]int) string {
	pairs, samples := 0, 0
	for _, n := range restored {
		if n > 0 {
			pairs++
			samples += n
		}
	}
	return fmt.Sprintf("%d pair(s), %d reading(s)", pairs, samples)
}

// exists reports whether the store found a file to read at all, so the boot
// log can say "absent" rather than report zero restored and leave an operator
// to guess which of the two it was.
func (s *oiStateStore) exists() bool {
	if s.path == "" {
		return false
	}
	_, err := os.Stat(s.path)
	return err == nil
}

// logRestore prints one line per pair with what came back. Twenty-six lines at
// boot is a lot, and it is still cheaper than the afternoon spent working out
// by hand whether a restore had happened: a row that restored nothing while
// the file held readings for it is visible here and nowhere else.
func (s *oiStateStore) logRestore(pairs []*pairRuntime, oi, liq map[string]int) {
	if s.path == "" {
		log.Printf("state: persistence disabled (STATE_PATH empty); every window starts empty and the rate waits a full span")
		return
	}
	if !s.exists() {
		log.Printf("state: %s absent; every window starts empty, which is expected on a first deploy", s.path)
		return
	}
	s.mu.Lock()
	haveOi, haveLiq := len(s.onDisk), len(s.liq)
	s.mu.Unlock()
	log.Printf("state: %s holds %d open-interest window(s) and %d liquidation window(s); restored open interest for %s and liquidations for %s",
		s.path, haveOi, haveLiq, fmtStateSummary(oi), fmtStateSummary(liq))
	for _, p := range pairs {
		key := oiStateKey(p.va.Venue, p.va.Asset)
		s.mu.Lock()
		onDisk := len(s.onDisk[key])
		s.mu.Unlock()
		switch {
		case onDisk == 0:
			log.Printf("state: %s had no open-interest readings on file", key)
		case oi[key] == 0:
			log.Printf("state: %s restored 0 of %d open-interest readings on file; every one was outside the window",
				key, onDisk)
		default:
			log.Printf("state: %s restored %d of %d open-interest readings and %d liquidation(s)",
				key, oi[key], onDisk, liq[key])
		}
	}
}
