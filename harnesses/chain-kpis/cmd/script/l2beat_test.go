package main

import (
	"encoding/json"
	"math"
	"os"
	"regexp"
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
	p.Tvs.Change7d = &change7d
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
	co := cohortMedianChange7d(small, 200e6)
	if co.OK {
		t.Fatalf("a 2-project cohort produced a median")
	}
	if co.Size != 2 {
		t.Fatalf("cohort size = %d, want 2 (the $1M project must be excluded)", co.Size)
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
	withFloor := cohortMedianChange7d(base, 200e6)
	if !withFloor.OK || math.Abs(withFloor.Median-10) > 1e-9 {
		t.Fatalf("median with floor = %v, want 10", withFloor.Median)
	}

	// Add eight dust chains that each tripled this week. Eight, not six:
	// the dust has to outnumber the real cohort before it owns the middle
	// of the sorted list, which is exactly why a median resists this and a
	// mean would not.
	for _, k := range []string{"t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"} {
		base[k] = proj(2e6, 0, 0, 0, 2.00, false)
	}
	stillWithFloor := cohortMedianChange7d(base, 200e6)
	if math.Abs(stillWithFloor.Median-10) > 1e-9 {
		t.Fatalf("dust moved the floored median to %v", stillWithFloor.Median)
	}
	if stillWithFloor.Size != 7 {
		t.Fatalf("cohort size = %d, want 7", stillWithFloor.Size)
	}

	noFloor := cohortMedianChange7d(base, 0)
	if math.Abs(noFloor.Median-10) < 1e-9 {
		t.Fatalf("without a floor the median should have moved, got %v", noFloor.Median)
	}
	t.Logf("median with floor %.1f%%, without floor %.1f%%", stillWithFloor.Median, noFloor.Median)
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
	co := cohortMedianChange7d(m, 200e6)
	if !co.OK || co.Size != 5 || math.Abs(co.Median-10) > 1e-9 {
		t.Fatalf("median=%v size=%d ok=%v; the archived project leaked in", co.Median, co.Size, co.OK)
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
	co := cohortMedianChange7d(m, 200e6)
	if !co.OK || math.Abs(co.Median-15) > 1e-9 {
		t.Fatalf("median = %v, want 15 (mean of 10 and 20)", co.Median)
	}
}

// The shape of the live payload, captured from l2beat.com/api/scaling/summary
// on 2026-09-23. Guards the field names: change7d is a ratio, not a percent,
// and the breakdown keys are the ones we read.
func TestParsesTheLivePayloadShape(t *testing.T) {
	// syncedUntil 1790157600 is 2026-09-23 10:00:00 UTC, read live at
	// 11:29 UTC: the series is hourly and was 89 minutes behind, which is
	// why the bench reads this clock and not our own fetch time.
	const body = `{"chart":{"syncedUntil":1790157600},
	  "projects":{"base":{"id":"base","name":"Base Chain","isArchived":false,
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
	if p.Tvs.Change7d == nil {
		t.Fatalf("change7d did not bind; the key was renamed upstream")
	}
	if *p.Tvs.Change7d > 1 {
		t.Fatalf("change7d = %v; it is a ratio, a value above 1 means the unit changed upstream", *p.Tvs.Change7d)
	}
	if s.Chart.SyncedUntil == 0 {
		t.Fatalf("chart.syncedUntil did not bind; it is the only clock that stops when L2Beat stalls while still answering 200")
	}
}

// The weekly columns need the same guard as the origin fields. A plain
// float64 would decode a renamed or null change7d as 0 for every project:
// the median becomes 0, and all twenty rows publish a flat week at full
// health. A missing value has to read as missing.
func TestAMissingChange7dDropsTheWeeklySeriesNotTheRow(t *testing.T) {
	chainBridgedTvlUsd.Reset()
	chainTvsChange7dPct.Reset()
	chainTvsChange7dExcessPct.Reset()

	noChange := proj(16441422848, 8222340259, 3121029128, 5098059233, 0, false)
	noChange.Tvs.Change7d = nil
	s := &l2beatSummary{Projects: map[string]l2beatProject{
		"base":     noChange,
		"arbitrum": proj(11874269184, 3692575462, 3803950446, 4377743276, 0.1020, false),
		"optimism": proj(1930874112, 392793661, 1192897272, 345183179, 0.1990, false),
		"mantle":   proj(1528454272, 46692460, 818479451, 663282361, 0.0750, false),
		"linea":    proj(384864000, 1925419, 133260387, 249678194, 0.1220, false),
		"celo":     proj(262609296, 243129539, 2587787, 16891970, 0.0430, false),
	}}
	publishL2Beat(s, &Config{L2BeatMedianFloorUSD: 200e6}, 1)

	// The balance is still good, so the row stays.
	if got := readGaugeVec(t, chainBridgedTvlUsd, "base"); math.Abs(got-8219088361) > 1 {
		t.Errorf("base bridged = %.0f; a missing weekly move must not drop the level", got)
	}
	// Its two weekly series must not exist rather than read zero.
	for name, g := range map[string]*prometheus.GaugeVec{
		"change": chainTvsChange7dPct, "excess": chainTvsChange7dExcessPct,
	} {
		ch := make(chan prometheus.Metric, 64)
		g.Collect(ch)
		close(ch)
		for m := range ch {
			d := &dto.Metric{}
			_ = m.Write(d)
			for _, l := range d.GetLabel() {
				if l.GetValue() == "base" {
					t.Errorf("base still has a %s series (%v); a nil change7d must delete it", name, d.GetGauge().GetValue())
				}
			}
		}
	}
	// And a project with no weekly move must not vote on the median.
	co := cohortMedianChange7d(s.Projects, 200e6)
	if co.Size != 5 {
		t.Errorf("cohort size %d, want 5: the project with a nil change7d voted", co.Size)
	}
}

// A chain L2Beat does not track in its scaling summary must not claim an
// id. The settled L1s below are the clear cases: they secure their own
// value with no host chain, so a bridged figure would read as "no capital
// came here" rather than "not applicable". Note this is narrower than
// "only rollups": Polygon PoS, Gnosis and Hyperliquid run their own
// consensus and are still tracked, which is why the bench copy says
// "chains L2Beat tracks" and not "rollups".
func TestSettledL1sCarryNoL2BeatID(t *testing.T) {
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
		// Five more so the cohort clears the minimum for a median. Each
		// carries a real split: the publish path refuses a project whose
		// origins do not reconstruct its total, so an all-zero breakdown
		// would be dropped before it reached a gauge.
		"arbitrum": proj(11874269184, 3692575462, 3803950446, 4377743276, 0.1020, false),
		"optimism": proj(1930874112, 392793661, 1192897272, 345183179, 0.1990, false),
		"mantle":   proj(1528454272, 46692460, 818479451, 663282361, 0.0750, false),
		"linea":    proj(384864000, 1925419, 133260387, 249678194, 0.1220, false),
		"celo":     proj(262609296, 243129539, 2587787, 16891970, 0.0430, false),
	}}
	cfg := &Config{L2BeatMedianFloorUSD: 200e6}
	publishL2Beat(s, cfg, 42)

	co := cohortMedianChange7d(s.Projects, 200e6)
	if !co.OK || co.Size != 7 {
		t.Fatalf("cohort size %d ok %v", co.Size, co.OK)
	}
	median := co.Median
	if co.UnderReview != 0 || co.Layer3 != 0 {
		t.Errorf("fixture has no under-review or layer3 project but counts say %d/%d",
			co.UnderReview, co.Layer3)
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

// If L2Beat renames an origin field, every value we read binds to zero and
// the board would publish a $0 bridged TVL at full health: a wrong number
// wearing the clothes of a measured one. The guard has to drop the row.
func TestSchemaDriftDropsTheRowInsteadOfPublishingZero(t *testing.T) {
	chainBridgedTvlUsd.Reset()
	chainKpisHealth.Reset()

	drifted := proj(16441422848, 0, 0, 0, 0.15, false) // total binds, origins do not
	s := &l2beatSummary{Projects: map[string]l2beatProject{"base": drifted}}
	publishL2Beat(s, &Config{L2BeatMedianFloorUSD: 200e6}, 1)

	if n := countSeries(t, chainBridgedTvlUsd); n != 0 {
		t.Fatalf("published %d bridged series from a drifted payload; expected none", n)
	}
	if h := readGaugeVec(t, chainKpisHealth, "base", "l2beat"); h != 0 {
		t.Fatalf("health = %v after schema drift, want 0", h)
	}
}

// A cohort that falls under the minimum must take the excess series with
// it. A frozen excess keeps every row looking defensible against a
// yardstick that no longer exists.
func TestTooSmallACohortClearsTheExcessSeries(t *testing.T) {
	full := &l2beatSummary{Projects: map[string]l2beatProject{
		"base":     proj(16441422848, 8222340259, 3121029128, 5098059233, 0.1524, false),
		"arbitrum": proj(11874269184, 3692575462, 3803950446, 4377743276, 0.1020, false),
		"optimism": proj(1930874112, 392793661, 1192897272, 345183179, 0.1990, false),
		"mantle":   proj(1528454272, 46692460, 818479451, 663282361, 0.0750, false),
		"linea":    proj(384864000, 1925419, 133260387, 249678194, 0.1220, false),
	}}
	publishL2Beat(full, &Config{L2BeatMedianFloorUSD: 200e6}, 1)
	if countSeries(t, chainTvsChange7dExcessPct) == 0 {
		t.Fatalf("a 5-project cohort published no excess at all")
	}

	// Same payload, floor raised so only two projects clear it.
	publishL2Beat(full, &Config{L2BeatMedianFloorUSD: 5e9}, 1)
	if n := countSeries(t, chainTvsChange7dExcessPct); n != 0 {
		t.Fatalf("%d excess series survived a cohort of 2", n)
	}
}

func countSeries(t *testing.T, g *prometheus.GaugeVec) int {
	t.Helper()
	ch := make(chan prometheus.Metric, 256)
	g.Collect(ch)
	close(ch)
	n := 0
	for range ch {
		n++
	}
	return n
}

// Every registry chain that carries an L2Beat id must also be a row on the
// bench, and the reverse. The first audit round shipped a board whose copy
// said "the chains L2Beat tracks" while 21 such chains had no row, three of
// them large enough to vote on the median every other row is judged
// against. A mismatch here is that bug coming back.
func TestEveryMappedChainHasABenchRow(t *testing.T) {
	spec, err := os.ReadFile("../../../../benchmarks/chain-bridged-tvl.yml")
	if err != nil {
		t.Skipf("spec not readable from here: %v", err)
	}
	rows := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^  - slug: ([a-z0-9-]+)$`).FindAllSubmatch(spec, -1) {
		rows[string(m[1])] = true
	}
	if len(rows) == 0 {
		t.Fatalf("parsed no provider rows out of the spec")
	}

	mapped := map[string]bool{}
	for _, c := range Registry {
		if c.L2Beat != "" {
			mapped[c.Slug] = true
		}
	}

	for slug := range mapped {
		if !rows[slug] {
			t.Errorf("%s carries an L2Beat id but has no row on bench 273", slug)
		}
	}
	for slug := range rows {
		if !mapped[slug] {
			t.Errorf("bench 273 has a row for %s, which carries no L2Beat id", slug)
		}
	}
	t.Logf("%d mapped chains, %d bench rows", len(mapped), len(rows))
}

// A chain the harness refuses must stop answering queries, not keep the
// last value it had. Because the gauges are re-exported every 30 s, a
// refused row's headline last_over_time(...[1h]) kept resolving, its row
// badge stayed fresh, and the only exit was the 5 % success floor — which
// a 24h success rate reaches 22.8 hours later. An archived chain would
// have held a place on the board for most of a day, with an excess
// measured against a median that had already moved.
func TestARefusedChainStopsPublishing(t *testing.T) {
	good := map[string]l2beatProject{
		"base":     proj(16441422848, 8222340259, 3121029128, 5098059233, 0.1524, false),
		"arbitrum": proj(11874269184, 3692575462, 3803950446, 4377743276, 0.1020, false),
		"optimism": proj(1930874112, 392793661, 1192897272, 345183179, 0.1990, false),
		"mantle":   proj(1528454272, 46692460, 818479451, 663282361, 0.0750, false),
		"linea":    proj(384864000, 1925419, 133260387, 249678194, 0.1220, false),
		"celo":     proj(262609296, 243129539, 2587787, 16891970, 0.0430, false),
	}
	cfg := &Config{L2BeatMedianFloorUSD: 200e6}

	for name, breaking := range map[string]func(map[string]l2beatProject){
		"archived":     func(m map[string]l2beatProject) { p := m["celo"]; p.IsArchived = true; m["celo"] = p },
		"zero total":   func(m map[string]l2beatProject) { m["celo"] = proj(0, 0, 0, 0, 0.04, false) },
		"schema drift": func(m map[string]l2beatProject) { m["celo"] = proj(262609296, 0, 0, 0, 0.04, false) },
		"gone":         func(m map[string]l2beatProject) { delete(m, "celo") },
	} {
		chainBridgedTvlUsd.Reset()
		chainTvsUsd.Reset()
		chainValueSecuredUsd.Reset()
		chainTvsChange7dPct.Reset()
		chainTvsChange7dExcessPct.Reset()

		// Publish a healthy tick first, so there is something to forget.
		healthy := map[string]l2beatProject{}
		for k, v := range good {
			healthy[k] = v
		}
		publishL2Beat(&l2beatSummary{Projects: healthy}, cfg, 1)
		if readGaugeVec(t, chainBridgedTvlUsd, "celo") == 0 {
			t.Fatalf("%s: celo did not publish on the healthy tick", name)
		}

		broken := map[string]l2beatProject{}
		for k, v := range good {
			broken[k] = v
		}
		breaking(broken)
		publishL2Beat(&l2beatSummary{Projects: broken}, cfg, 1)

		for label, g := range map[string]*prometheus.GaugeVec{
			"bridged": chainBridgedTvlUsd, "tvs": chainTvsUsd,
			"change": chainTvsChange7dPct, "excess": chainTvsChange7dExcessPct,
			"origins": chainValueSecuredUsd,
		} {
			if hasLabel(t, g, "celo") {
				t.Errorf("%s: celo still publishes %s after being refused", name, label)
			}
		}
		// The chains that are still good must be untouched.
		if readGaugeVec(t, chainBridgedTvlUsd, "base") == 0 {
			t.Errorf("%s: forgetting celo took base with it", name)
		}
	}
}

func hasLabel(t *testing.T, g *prometheus.GaugeVec, want string) bool {
	t.Helper()
	ch := make(chan prometheus.Metric, 256)
	g.Collect(ch)
	close(ch)
	for m := range ch {
		d := &dto.Metric{}
		_ = m.Write(d)
		for _, l := range d.GetLabel() {
			if l.GetValue() == want {
				return true
			}
		}
	}
	return false
}
