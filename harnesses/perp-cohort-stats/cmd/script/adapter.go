package main

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// Source is the minimal contract a fetcher implements. Each source
// independently knows how to populate one or more (venue, metric)
// pairs. The router below picks the first source whose Fetch returns
// a non-nil value, per the priority map per metric.
//
// Implementations write directly into a *SourceResult and never block
// the harness loop on errors: any failure increments the fetch-errors
// counter and returns nil for the metrics it could not populate.
type Source interface {
	Name() string
	// Fetch executes one call (or batch of calls) and returns a
	// SourceResult keyed by (venue, metric). Missing keys mean the
	// source had no opinion on that pair (e.g. Lighter native does not
	// publish fees, so it never returns a "fees_30d" key).
	Fetch() (*SourceResult, error)
}

// SourceResult is the structured output of a Source.Fetch: a per-venue
// map of metric -> value plus per-(venue, asset) funding maps. We use
// composite metric keys (e.g. "volume_24h", "oi", "fees_30d") that
// match the router's priority map.
type SourceResult struct {
	// Values is keyed [venue][metric] -> float64.
	Values map[string]map[string]float64
	// Funding is keyed [venue][asset] -> (bps_24h, intervalHours).
	Funding map[string]map[string]fundingPoint
}

type fundingPoint struct {
	Bps24h        float64
	IntervalHours float64
}

func newSourceResult() *SourceResult {
	return &SourceResult{
		Values:  map[string]map[string]float64{},
		Funding: map[string]map[string]fundingPoint{},
	}
}

func (r *SourceResult) Set(venue, metric string, v float64) {
	if r.Values[venue] == nil {
		r.Values[venue] = map[string]float64{}
	}
	r.Values[venue][metric] = v
}

// SetIfPositive only writes the metric when v > 0. Native sources use
// this to avoid publishing a zero (which the router would treat as a
// real value and use to overwrite carry-forward). A truly-zero venue
// either has no markets, is dead, or its API hiccuped: in all three
// cases carry-forward is more correct than publishing 0.
func (r *SourceResult) SetIfPositive(venue, metric string, v float64) {
	if v <= 0 {
		return
	}
	r.Set(venue, metric, v)
}

func (r *SourceResult) SetFunding(venue, asset string, p fundingPoint) {
	if r.Funding[venue] == nil {
		r.Funding[venue] = map[string]fundingPoint{}
	}
	r.Funding[venue][asset] = p
}

// Metric names used in the priority map. These are internal-only;
// the published Prom metric names live in metrics.go.
const (
	mVolume24h     = "volume_24h"
	mVolume30d     = "volume_30d"
	mOI            = "oi"
	mFees30d       = "fees_30d"
	mActiveMarkets = "active_markets"
	mTopVol24h     = "top_market_volume_24h"
)

// Source names. Keep these stable: they appear as Prom label values
// on perp_venue_last_refresh_unix{source=...} and
// perp_cohort_stats_source_used{source=...}.
const (
	srcHLNative      = "hl_native"
	srcLighterNative = "lighter_native"
	srcDydxNative    = "dydx_native"
	srcParadexNative = "paradex_native"
	srcEdgexNative   = "edgex_native"
	srcAsterNative   = "aster_native"
	srcVertexNative  = "vertex_native"
	srcGrvtNative        = "grvt_native"
	srcExtendedNative    = "extended_native"
	srcAevoNative        = "aevo_native"
	srcPacificaNative    = "pacifica_native"
	srcVariationalNative = "variational_native"
	srcOstiumNative      = "ostium_native"
	srcPolymarketNative  = "polymarket_native"
	srcDefillama         = "defillama"
	srcMobulaPairs   = "mobula_pairs"
	srcMobulaFund    = "mobula_funding"
)

// priorityMap returns the ordered source preference for (venue, metric).
// First source returning a non-nil value wins; remaining sources still
// run (so cross-check can fire) but their value is not published.
func priorityMap(venue, metric string) []string {
	switch metric {
	case mVolume24h:
		switch venue {
		case "hyperliquid":
			return []string{srcHLNative, srcDefillama}
		case "lighter":
			return []string{srcLighterNative, srcDefillama}
		case "gmx-v2", "gains":
			return []string{srcDefillama}
		case "dydx":
			return []string{srcDydxNative, srcDefillama}
		case "paradex":
			return []string{srcParadexNative, srcDefillama}
		case "edgex":
			return []string{srcEdgexNative, srcDefillama}
		case "aster":
			return []string{srcAsterNative, srcDefillama}
		case "vertex":
			return []string{srcVertexNative, srcDefillama}
		case "grvt":
			return []string{srcGrvtNative, srcDefillama}
		case "extended":
			return []string{srcExtendedNative, srcDefillama}
		case "aevo":
			return []string{srcAevoNative, srcDefillama}
		case "pacifica":
			return []string{srcPacificaNative, srcDefillama}
		case "variational":
			// Native REST blocked (see source_variational.go).
			// DefiLlama is the only path.
			return []string{srcDefillama}
		case "ostium":
			// Subgraph exposes OI but no 24h rolling volume; defer
			// vol_24h to DefiLlama.
			return []string{srcDefillama}
		case "polymarket":
			return []string{srcPolymarketNative}
		}
	case mVolume30d:
		switch venue {
		case "hyperliquid":
			return []string{srcHLNative, srcDefillama}
		case "lighter":
			return []string{srcLighterNative, srcDefillama}
		case "gmx-v2", "gains":
			return []string{srcDefillama}
		case "vertex":
			// DefiLlama vertex-perps returns null for vol30d, so the
			// native archive (31 daily granules diffed) is primary.
			return []string{srcVertexNative, srcDefillama}
		case "dydx", "paradex", "edgex", "aster", "grvt",
			"extended", "aevo", "pacifica", "variational", "ostium":
			// No native 30d aggregate exposed on these venues; rely
			// on DefiLlama for the trailing-window number.
			return []string{srcDefillama}
		case "polymarket":
			// Day-2 venue: no native 30d aggregate and not on
			// DefiLlama yet. Leave unset until either ships.
			return nil
		}
	case mOI:
		switch venue {
		case "hyperliquid":
			return []string{srcHLNative, srcDefillama}
		case "lighter":
			return []string{srcLighterNative, srcDefillama}
		case "gmx-v2", "gains":
			return []string{srcDefillama}
		case "dydx":
			return []string{srcDydxNative, srcDefillama}
		case "paradex":
			return []string{srcParadexNative, srcDefillama}
		case "edgex":
			return []string{srcEdgexNative, srcDefillama}
		case "aster":
			return []string{srcAsterNative, srcDefillama}
		case "vertex":
			return []string{srcVertexNative, srcDefillama}
		case "grvt":
			return []string{srcGrvtNative, srcDefillama}
		case "extended":
			return []string{srcExtendedNative, srcDefillama}
		case "aevo":
			return []string{srcAevoNative, srcDefillama}
		case "pacifica":
			return []string{srcPacificaNative, srcDefillama}
		case "ostium":
			// Subgraph OI is authoritative (BASE*price computed from
			// longOI/shortOI + lastTradePrice). DefiLlama as fallback.
			return []string{srcOstiumNative, srcDefillama}
		case "variational":
			// Native REST blocked. DefiLlama is the only path.
			return []string{srcDefillama}
		case "polymarket":
			return []string{srcPolymarketNative}
		}
	case mFees30d:
		switch venue {
		case "vertex":
			// DefiLlama vertex-perps returns null for fees, so the
			// native archive (cumulative_taker_fees + cumulative_maker_fees
			// diffed across 31 daily granules) is primary.
			return []string{srcVertexNative, srcDefillama}
		}
		return []string{srcDefillama}
	case mActiveMarkets:
		switch venue {
		case "hyperliquid":
			return []string{srcHLNative}
		case "lighter":
			// Lighter native is the authoritative count: it filters
			// market_type=="perp" + status=="active". Mobula pairs
			// counts the whole catalog and diverges constantly here,
			// so we keep it for `gains` (where Lighter does not
			// publish) but drop it from the lighter priority list.
			return []string{srcLighterNative}
		case "gains":
			return []string{srcMobulaPairs}
		case "gmx-v2":
			return []string{srcDefillama}
		case "dydx":
			return []string{srcDydxNative}
		case "paradex":
			return []string{srcParadexNative}
		case "edgex":
			return []string{srcEdgexNative}
		case "aster":
			return []string{srcAsterNative}
		case "vertex":
			return []string{srcVertexNative}
		case "grvt":
			return []string{srcGrvtNative}
		case "extended":
			return []string{srcExtendedNative}
		case "aevo":
			return []string{srcAevoNative}
		case "pacifica":
			return []string{srcPacificaNative}
		case "ostium":
			return []string{srcOstiumNative}
		case "variational":
			// No native source can resolve active_markets without
			// hitting the same blocked APIs. Leave unset; carry-
			// forward will keep the gauge empty until a source ships.
			return nil
		case "polymarket":
			return []string{srcPolymarketNative}
		}
	case mTopVol24h:
		switch venue {
		case "hyperliquid":
			return []string{srcHLNative}
		case "lighter":
			return []string{srcLighterNative}
		case "dydx":
			return []string{srcDydxNative}
		case "paradex":
			return []string{srcParadexNative}
		case "edgex":
			return []string{srcEdgexNative}
		case "aster":
			return []string{srcAsterNative}
		case "vertex":
			return []string{srcVertexNative}
		case "grvt":
			return []string{srcGrvtNative}
		case "extended":
			return []string{srcExtendedNative}
		case "aevo":
			return []string{srcAevoNative}
		case "pacifica":
			return []string{srcPacificaNative}
		case "variational", "ostium":
			// No top-market signal: Variational native is blocked, and
			// the Ostium subgraph has no rolling 24h volume column.
			return nil
		case "polymarket":
			return []string{srcPolymarketNative}
		}
	}
	return nil
}

// Router orchestrates one sweep across all registered sources.
type Router struct {
	cfg     *Config
	sources []Source
	// carry holds the last successfully published value per (venue,
	// metric). On a total-miss tick we re-emit the previous value but
	// do NOT advance perp_venue_last_refresh_unix, so the UI can
	// compute true data age.
	carry      map[string]map[string]carryEntry
	carryMu    sync.Mutex
	fundCarry  map[string]map[string]fundingCarryEntry
	fundCarryM sync.Mutex
}

type carryEntry struct {
	Value      float64
	RefreshTS  int64
	LastSource string
}

type fundingCarryEntry struct {
	Bps24h        float64
	IntervalHours float64
	RefreshTS     int64
}

func NewRouter(cfg *Config) *Router {
	sources := []Source{
		NewHyperliquidNativeSource(),
		NewLighterNativeSource(),
		NewDydxNativeSource(),
		NewParadexNativeSource(),
		NewEdgexNativeSource(),
		NewAsterNativeSource(),
		NewVertexNativeSource(),
		NewGrvtNativeSource(),
		NewExtendedNativeSource(),
		NewAevoNativeSource(),
		NewPacificaNativeSource(),
		NewVariationalNativeSource(),
		NewOstiumNativeSource(),
		NewPolymarketNativeSource(),
		NewDefillamaScrapeSource(),
	}
	if cfg.MobulaAPIKey != "" {
		sources = append(sources,
			NewMobulaFundingSource(cfg.MobulaAPIKey, cfg.MobulaFundingVenues),
			NewMobulaPairsSource(cfg.MobulaAPIKey),
		)
	} else {
		fmt.Println("[router] Mobula sources disabled (MOBULA_API_KEY unset)")
	}
	return &Router{
		cfg:       cfg,
		sources:   sources,
		carry:     map[string]map[string]carryEntry{},
		fundCarry: map[string]map[string]fundingCarryEntry{},
	}
}

func (r *Router) carryGet(venue, metric string) (carryEntry, bool) {
	r.carryMu.Lock()
	defer r.carryMu.Unlock()
	if r.carry[venue] == nil {
		return carryEntry{}, false
	}
	e, ok := r.carry[venue][metric]
	return e, ok
}

func (r *Router) carrySet(venue, metric string, v float64, source string, ts int64) {
	r.carryMu.Lock()
	defer r.carryMu.Unlock()
	if r.carry[venue] == nil {
		r.carry[venue] = map[string]carryEntry{}
	}
	r.carry[venue][metric] = carryEntry{Value: v, LastSource: source, RefreshTS: ts}
}

func (r *Router) fundingCarryGet(venue, asset string) (fundingCarryEntry, bool) {
	r.fundCarryM.Lock()
	defer r.fundCarryM.Unlock()
	if r.fundCarry[venue] == nil {
		return fundingCarryEntry{}, false
	}
	e, ok := r.fundCarry[venue][asset]
	return e, ok
}

func (r *Router) fundingCarrySet(venue, asset string, p fundingPoint, ts int64) {
	r.fundCarryM.Lock()
	defer r.fundCarryM.Unlock()
	if r.fundCarry[venue] == nil {
		r.fundCarry[venue] = map[string]fundingCarryEntry{}
	}
	r.fundCarry[venue][asset] = fundingCarryEntry{
		Bps24h:        p.Bps24h,
		IntervalHours: p.IntervalHours,
		RefreshTS:     ts,
	}
}

// Sweep runs every registered source, picks a winner per (venue, metric)
// from the priority map, runs the cross-check on the secondary, publishes
// gauges, and carries forward any (venue, metric) that fully missed.
func (r *Router) Sweep() {
	tickTS := time.Now().Unix()
	defer perpCohortLastTickUnix.Set(float64(tickTS))

	// Fan-out: each source runs in its own goroutine with a 15s upper
	// bound enforced inside the HTTP client. We collect per-source
	// results and process them serially for deterministic precedence.
	type fetched struct {
		src    Source
		result *SourceResult
		err    error
	}
	results := make([]fetched, len(r.sources))
	var wg sync.WaitGroup
	for i, s := range r.sources {
		wg.Add(1)
		go func(i int, s Source) {
			defer wg.Done()
			res, err := s.Fetch()
			results[i] = fetched{src: s, result: res, err: err}
		}(i, s)
	}
	wg.Wait()

	// Build a lookup of source-name -> SourceResult for the priority
	// router. nil results are kept so we can tell "ran and failed" from
	// "not registered".
	byName := map[string]*SourceResult{}
	for _, f := range results {
		name := f.src.Name()
		if f.err != nil {
			fmt.Printf("[perp-cohort][_][%s] err: %v\n", name, f.err)
			// Per-venue error attribution is done at the source level
			// already (sources increment perpCohortFetchErrors with the
			// correct venue label before returning). The wrapper error
			// here is logged only.
			continue
		}
		byName[name] = f.result
	}

	// Resolve each (venue, metric) using priorityMap. Run cross-check
	// against the next source in the priority list.
	cohortMetrics := []string{mVolume24h, mVolume30d, mOI, mFees30d, mActiveMarkets, mTopVol24h}
	for _, v := range Registry {
		var healthHits, healthTotal int
		for _, metric := range cohortMetrics {
			prio := priorityMap(v.Slug, metric)
			if len(prio) == 0 {
				continue
			}
			healthTotal++

			var winner string
			var winnerVal float64
			var winnerFound bool
			var secondVal float64
			var secondFound bool
			for _, name := range prio {
				res := byName[name]
				if res == nil {
					continue
				}
				val, ok := lookup(res, v.Slug, metric)
				if !ok {
					continue
				}
				if !winnerFound {
					winner = name
					winnerVal = val
					winnerFound = true
					continue
				}
				if !secondFound {
					secondVal = val
					secondFound = true
				}
			}

			if winnerFound {
				healthHits++
				publishCohort(v.Slug, metric, winnerVal)
				perpVenueLastRefreshUnix.WithLabelValues(v.Slug, winner).Set(float64(tickTS))
				// Reset source-used label set for this (venue, metric)
				// then set winner=1. Reset uses a small known label set.
				for _, name := range prio {
					perpCohortSourceUsed.WithLabelValues(v.Slug, metric, name).Set(0)
				}
				perpCohortSourceUsed.WithLabelValues(v.Slug, metric, winner).Set(1)
				r.carrySet(v.Slug, metric, winnerVal, winner, tickTS)

				if secondFound {
					if divergent(winnerVal, secondVal, 0.10) {
						perpCohortDataDivergence.WithLabelValues(v.Slug, metric).Inc()
					}
				}
			} else {
				// Carry-forward: republish the last known value if we
				// have one, but do NOT advance the refresh timestamp.
				if e, ok := r.carryGet(v.Slug, metric); ok {
					publishCohort(v.Slug, metric, e.Value)
				}
			}
		}

		// Health: fraction of metrics with primary-source success this tick.
		if healthTotal > 0 {
			perpVenueHealth.WithLabelValues(v.Slug).Set(float64(healthHits) / float64(healthTotal))
		}
	}

	// Funding is a separate publish path because it is keyed by (venue,
	// asset), not just venue. The Mobula source is currently the only
	// funding source; carry-forward applies per (venue, asset).
	//
	// We publish funding for EVERY venue Mobula returns (12 CEFI+DEX
	// venues in the default cohort), not just the OCB perp-DEX
	// Registry. The funding gauge surface is used by adjacent UI
	// panels (CEFI vs DEX funding spread, cross-venue funding
	// arbitrage), so the broader cardinality is intentional.
	mobula := byName[srcMobulaFund]
	if mobula != nil {
		for venueSlug, perAsset := range mobula.Funding {
			for asset, p := range perAsset {
				perpVenueFunding24hBps.WithLabelValues(venueSlug, asset).Set(p.Bps24h)
				perpVenueFundingIntervalHours.WithLabelValues(venueSlug, asset).Set(p.IntervalHours)
				perpVenueLastRefreshUnix.WithLabelValues(venueSlug, srcMobulaFund).Set(float64(tickTS))
				r.fundingCarrySet(venueSlug, asset, p, tickTS)
			}
		}
	}
	// Carry-forward for any (venue, asset) we previously had but did
	// not refresh this tick.
	r.fundCarryM.Lock()
	for venueSlug, perAsset := range r.fundCarry {
		for asset, e := range perAsset {
			if e.RefreshTS == tickTS {
				continue
			}
			perpVenueFunding24hBps.WithLabelValues(venueSlug, asset).Set(e.Bps24h)
			perpVenueFundingIntervalHours.WithLabelValues(venueSlug, asset).Set(e.IntervalHours)
		}
	}
	r.fundCarryM.Unlock()

	// Reap stale carry entries so renamed/removed venues do not leak
	// memory and never republish ghost values forever. Cohort metrics
	// are pruned against the canonical Registry (rename = remove from
	// registry + re-add under new slug = old slug evicted). Funding
	// entries are pruned against a 24h max-age window so CEFI venues
	// Mobula stopped covering also drop out.
	r.reapCohortCarry()
	r.reapFundingCarry(tickTS, 24*60*60)
}

// reapCohortCarry drops any venue from the cohort carry map that is
// no longer in Registry. Safe to call after every sweep; cheap.
func (r *Router) reapCohortCarry() {
	r.carryMu.Lock()
	defer r.carryMu.Unlock()
	keep := map[string]struct{}{}
	for _, v := range Registry {
		keep[v.Slug] = struct{}{}
	}
	for venue := range r.carry {
		if _, ok := keep[venue]; !ok {
			delete(r.carry, venue)
		}
	}
}

// reapFundingCarry drops any (venue, asset) carry entry older than
// maxAgeSec. The funding cardinality is broader than Registry (CEFI
// venues like binance, bybit are included on purpose for adjacent UI
// panels), so we cannot prune against Registry. Age is the next best
// signal: if Mobula stopped publishing a venue for 24h it should fall
// off the gauge.
func (r *Router) reapFundingCarry(nowTS int64, maxAgeSec int64) {
	r.fundCarryM.Lock()
	defer r.fundCarryM.Unlock()
	for venue, perAsset := range r.fundCarry {
		for asset, e := range perAsset {
			if nowTS-e.RefreshTS > maxAgeSec {
				delete(perAsset, asset)
			}
		}
		if len(perAsset) == 0 {
			delete(r.fundCarry, venue)
		}
	}
}

func lookup(r *SourceResult, venue, metric string) (float64, bool) {
	if r == nil || r.Values[venue] == nil {
		return 0, false
	}
	v, ok := r.Values[venue][metric]
	return v, ok
}

// publishCohort maps the internal metric key to the Prom gauge.
func publishCohort(venue, metric string, val float64) {
	switch metric {
	case mVolume24h:
		perpVenueVolume24hUsd.WithLabelValues(venue).Set(val)
	case mVolume30d:
		perpVenueVolume30dUsd.WithLabelValues(venue).Set(val)
	case mOI:
		perpVenueOIUsd.WithLabelValues(venue).Set(val)
	case mFees30d:
		perpVenueFees30dUsd.WithLabelValues(venue).Set(val)
	case mActiveMarkets:
		perpVenueActiveMarkets.WithLabelValues(venue).Set(val)
	case mTopVol24h:
		perpVenueTopMarketVolume24hUsd.WithLabelValues(venue).Set(val)
	}
}

// divergent returns true if |a-b|/max(a,b) > threshold.
// Returns false if either value is non-positive (cross-check skipped
// when one side is zero/missing).
func divergent(a, b, threshold float64) bool {
	if a <= 0 || b <= 0 {
		return false
	}
	m := math.Max(a, b)
	if m == 0 {
		return false
	}
	return math.Abs(a-b)/m > threshold
}
