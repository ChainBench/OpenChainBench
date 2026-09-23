package main

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func proj(total, native, canonical, external, change7d float64, archived bool) l2beatProject {
	p := l2beatProject{IsArchived: archived}
	p.Tvs.Breakdown.Total = total
	p.Tvs.Breakdown.Native = native
	p.Tvs.Breakdown.Canonical = canonical
	p.Tvs.Breakdown.External = external
	p.Tvs.Change7d = change7d
	return p
}

// A cohort under the floor must not produce a median. Publishing an excess
// against a number drawn from two chains would read as a market comparison
// while being an accident of which two chains happened to clear the bar.
func TestMedianRefusesATooSmallCohort(t *testing.T) {
	small := map[string]l2beatProject{
		"a": proj(500e6, 0, 0, 0, 0.10, false),
		"b": proj(400e6, 0, 0, 0, 0.20, false),
		"c": proj(1e6, 0, 0, 0, 5.00, false), // below the floor, must not vote
	}
	_, size, ok := cohortMedianChange7d(small, 200e6)
	if ok {
		t.Fatalf("a 2-project cohort produced a median")
	}
	if size != 2 {
		t.Fatalf("cohort size = %d, want 2 (the $1M project must be excluded)", size)
	}
}

// The floor is the whole point of the metric: without it one tiny chain
// doubling on an incentive program drags the reference move the entire
// cohort is judged against.
func TestFloorKeepsTheMedianFromBeingSetByDust(t *testing.T) {
	base := map[string]l2beatProject{}
	for _, k := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		base[k] = proj(1e9, 0, 0, 0, 0.10, false) // seven big chains, all +10%
	}
	withFloor, _, ok := cohortMedianChange7d(base, 200e6)
	if !ok || math.Abs(withFloor-10) > 1e-9 {
		t.Fatalf("median with floor = %v, want 10", withFloor)
	}

	// Add eight dust chains that each tripled this week. Eight, not six:
	// the dust has to outnumber the real cohort before it owns the middle
	// of the sorted list, which is exactly why a median resists this and a
	// mean would not.
	for _, k := range []string{"t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"} {
		base[k] = proj(2e6, 0, 0, 0, 2.00, false)
	}
	stillWithFloor, size, _ := cohortMedianChange7d(base, 200e6)
	if math.Abs(stillWithFloor-10) > 1e-9 {
		t.Fatalf("dust moved the floored median to %v", stillWithFloor)
	}
	if size != 7 {
		t.Fatalf("cohort size = %d, want 7", size)
	}

	noFloor, _, _ := cohortMedianChange7d(base, 0)
	if math.Abs(noFloor-10) < 1e-9 {
		t.Fatalf("without a floor the median should have moved, got %v", noFloor)
	}
	t.Logf("median with floor %.1f%%, without floor %.1f%%", stillWithFloor, noFloor)
}

func TestArchivedProjectsDoNotVote(t *testing.T) {
	m := map[string]l2beatProject{
		"a": proj(1e9, 0, 0, 0, 0.10, false),
		"b": proj(1e9, 0, 0, 0, 0.10, false),
		"c": proj(1e9, 0, 0, 0, 0.10, false),
		"d": proj(1e9, 0, 0, 0, 0.10, false),
		"e": proj(1e9, 0, 0, 0, 0.10, false),
		"z": proj(9e9, 0, 0, 0, 9.99, true),
	}
	median, size, ok := cohortMedianChange7d(m, 200e6)
	if !ok || size != 5 || math.Abs(median-10) > 1e-9 {
		t.Fatalf("median=%v size=%d ok=%v; the archived project leaked in", median, size, ok)
	}
}

func TestMedianIsTheAverageOfTheTwoMiddlesWhenEven(t *testing.T) {
	m := map[string]l2beatProject{
		"a": proj(1e9, 0, 0, 0, 0.02, false),
		"b": proj(1e9, 0, 0, 0, 0.04, false),
		"c": proj(1e9, 0, 0, 0, 0.10, false),
		"d": proj(1e9, 0, 0, 0, 0.20, false),
		"e": proj(1e9, 0, 0, 0, 0.30, false),
		"f": proj(1e9, 0, 0, 0, 0.40, false),
	}
	median, _, ok := cohortMedianChange7d(m, 200e6)
	if !ok || math.Abs(median-15) > 1e-9 {
		t.Fatalf("median = %v, want 15 (mean of 10 and 20)", median)
	}
}

// The shape of the live payload, captured from l2beat.com/api/scaling/summary
// on 2026-09-23. Guards the field names: change7d is a ratio, not a percent,
// and the breakdown keys are the ones we read.
func TestParsesTheLivePayloadShape(t *testing.T) {
	const body = `{"projects":{"base":{"id":"base","name":"Base Chain","isArchived":false,
	  "tvs":{"breakdown":{"total":16441422848,"native":8222340259.25,
	  "canonical":3121029128.129638,"external":5098059233.275391,
	  "stablecoin":4792403636,"btc":4165800685},"change7d":0.1524300323433938}}}}`

	var s l2beatSummary
	if err := json.Unmarshal([]byte(body), &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p := s.Projects["base"]
	b := p.Tvs.Breakdown
	if b.Total == 0 || b.Native == 0 || b.Canonical == 0 || b.External == 0 {
		t.Fatalf("a breakdown field did not bind: %+v", b)
	}
	// The three origins must reconstruct the total, or "bridged" is not
	// "everything that is not native" and the derived gauge is wrong.
	sum := b.Native + b.Canonical + b.External
	if math.Abs(sum-b.Total)/b.Total > 0.001 {
		t.Fatalf("native+canonical+external = %.0f but total = %.0f", sum, b.Total)
	}
	bridged := b.Canonical + b.External
	if math.Abs(bridged-8219088361)/bridged > 0.001 {
		t.Fatalf("bridged TVL = %.0f, want ~8219088361", bridged)
	}
	if p.Tvs.Change7d > 1 {
		t.Fatalf("change7d = %v; it is a ratio, a value above 1 means the unit changed upstream", p.Tvs.Change7d)
	}
}

// Every registry row that claims an L2Beat id must be a rollup; an L1 has
// no bridge securing its value and would publish a bridged TVL of zero
// that reads as "no capital came here" rather than "not applicable".
func TestOnlyRollupsCarryAnL2BeatID(t *testing.T) {
	l1s := map[string]bool{
		"ethereum": true, "solana": true, "bnb": true, "avalanche": true,
		"sui": true, "gram": true, "stellar": true, "tron": true,
		"cardano": true, "litecoin": true, "monero": true, "polkadot": true,
	}
	for _, c := range Registry {
		if c.L2Beat != "" && l1s[c.Slug] {
			t.Errorf("%s is an L1 but carries L2Beat id %q", c.Slug, c.L2Beat)
		}
	}
}

// The derived gauges are the ones a bench page ranks on, so they have to
// be right for a chain whose value is entirely canonical (Hyperliquid) as
// well as for one with all three origins (Base).
func TestPublishDerivesBridgedAndExcess(t *testing.T) {
	s := &l2beatSummary{Projects: map[string]l2beatProject{
		"base":        proj(16441422848, 8222340259, 3121029128, 5098059233, 0.1524, false),
		"hyperliquid": proj(7507570688, 0, 7507570688, 0, 0.1510, false),
		// five more so the cohort clears the minimum for a median
		"arbitrum": proj(11874269184, 0, 0, 0, 0.1020, false),
		"optimism": proj(1930874112, 0, 0, 0, 0.1990, false),
		"mantle":   proj(1528454272, 0, 0, 0, 0.0750, false),
		"linea":    proj(384864000, 0, 0, 0, 0.1220, false),
		"celo":     proj(262609296, 0, 0, 0, 0.0430, false),
	}}
	cfg := &Config{L2BeatMedianFloorUSD: 200e6}
	publishL2Beat(s, cfg, 42)

	median, size, ok := cohortMedianChange7d(s.Projects, 200e6)
	if !ok || size != 7 {
		t.Fatalf("cohort size %d ok %v", size, ok)
	}

	// Base: bridged is everything that is not native.
	if got := readGaugeVec(t, chainBridgedTvlUsd, "base"); math.Abs(got-8219088361) > 1 {
		t.Errorf("base bridged = %.0f, want 8219088361", got)
	}
	// Hyperliquid secures no natively minted value: bridged == total.
	total := readGaugeVec(t, chainTvsUsd, "hyperliquid")
	bridged := readGaugeVec(t, chainBridgedTvlUsd, "hyperliquid")
	if math.Abs(total-bridged) > 1 {
		t.Errorf("hyperliquid total %.0f != bridged %.0f; a 100%% canonical chain must read as fully bridged", total, bridged)
	}
	// The excess is the raw change minus the published median, and the
	// published median is the one a reader can re-derive.
	raw := readGaugeVec(t, chainTvsChange7dPct, "celo")
	exc := readGaugeVec(t, chainTvsChange7dExcessPct, "celo")
	if math.Abs((raw-median)-exc) > 1e-6 {
		t.Errorf("celo excess %.4f != raw %.4f - median %.4f", exc, raw, median)
	}
	// Celo is up +4.3% on the week and still behind its peers. A ranking
	// on the raw number would have called that a gain.
	if raw <= 0 || exc >= 0 {
		t.Errorf("celo raw %.2f excess %.2f; expected a positive move that is negative against the cohort", raw, exc)
	}
	t.Logf("cohort median %+.1f%%; celo %+.1f%% raw, %+.1f pp against peers", median, raw, exc)
}

func readGaugeVec(t *testing.T, g *prometheus.GaugeVec, labels ...string) float64 {
	t.Helper()
	m := &dto.Metric{}
	gauge, err := g.GetMetricWithLabelValues(labels...)
	if err != nil {
		t.Fatalf("gauge lookup %v: %v", labels, err)
	}
	if err := gauge.Write(m); err != nil {
		t.Fatalf("gauge write %v: %v", labels, err)
	}
	return m.GetGauge().GetValue()
}

func TestRegistryL2BeatIDsAreUnique(t *testing.T) {
	seen := map[string]string{}
	for _, c := range Registry {
		if c.L2Beat == "" {
			continue
		}
		if prev, dup := seen[c.L2Beat]; dup {
			t.Errorf("L2Beat id %q claimed by both %s and %s", c.L2Beat, prev, c.Slug)
		}
		seen[c.L2Beat] = c.Slug
	}
	if len(seen) < 15 {
		t.Fatalf("only %d chains mapped; the batch verified on 2026-09-23 was 20", len(seen))
	}
}
