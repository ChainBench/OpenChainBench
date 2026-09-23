package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sort"
	"time"
)

// L2Beat publishes, for every rollup it tracks, the split of the value the
// chain secures into three origins:
//
//	native     — minted on the chain itself
//	canonical  — locked in the chain's own escrow on its host chain
//	external   — brought over by a third-party bridge
//
// canonical + external is the bridged TVL: value that came from somewhere
// else. DefiLlama serves the same idea behind a paid plan (/chainAssets
// answers 402), L2Beat serves it on a public endpoint, decomposed, with a
// 7-day change already computed.
//
// One request covers the whole cohort, unlike the DefiLlama loop which is
// per chain, so this file fetches once per tick and fans the result out
// over the registry rows that carry an L2Beat id.
//
// Source: https://l2beat.com/api/scaling/summary
const l2beatSummaryURL = "https://l2beat.com/api/scaling/summary"

var httpClientL2Beat = &http.Client{Timeout: 20 * time.Second}

// l2beatProject is the slice of one `projects` entry that we read.
//
// Type and IsUnderReview are decoded because both change how the median
// cohort should be read: the cohort contains layer3s, and projects L2Beat
// is re-verifying still publish a figure that votes. Their counts are
// exported so the yardstick's composition is visible rather than implied.
type l2beatProject struct {
	Name          string `json:"name"`
	Type          string `json:"type"`
	IsArchived    bool   `json:"isArchived"`
	IsUnderReview bool   `json:"isUnderReview"`
	Tvs           struct {
		Breakdown struct {
			Total     float64 `json:"total"`
			Native    float64 `json:"native"`
			Canonical float64 `json:"canonical"`
			External  float64 `json:"external"`
		} `json:"breakdown"`
		// Change7d is a ratio, not a percentage: 0.152 means +15.2%.
		//
		// A pointer, not a float64, for the same reason the origin fields
		// are guarded: if the key is renamed or nulled upstream, a plain
		// float decodes as 0 for every project, the median becomes 0, and
		// all twenty rows publish a weekly move of exactly zero at full
		// health. A nil is a missing value and is treated as one.
		Change7d *float64 `json:"change7d"`
	} `json:"tvs"`
}

type l2beatSummary struct {
	Projects map[string]l2beatProject `json:"projects"`
	Chart    struct {
		// Unix seconds of the last point L2Beat has actually computed.
		// Without it, "fresh" means only that our HTTP call succeeded: if
		// L2Beat stops syncing and keeps answering 200, every tick
		// republishes the same hour-old numbers at full health and the
		// page never says so. This is the timestamp the bench reads.
		SyncedUntil int64 `json:"syncedUntil"`
	} `json:"chart"`
}

// cohortMedianChange7d is the median 7-day change across every live
// project above floorUSD, in percent.
//
// The floor exists because the median is the yardstick the excess metric
// is measured against: a cohort that lets $2M chains vote is a cohort
// where one airdrop sets the market's reference move. It returns ok=false
// when too few projects clear the floor for a median to mean anything,
// and the caller then publishes no excess rather than an excess against a
// number it cannot defend.
func cohortMedianChange7d(projects map[string]l2beatProject, floorUSD float64) (c cohort) {
	changes := []float64{}
	for _, p := range projects {
		if p.IsArchived || p.Tvs.Breakdown.Total < floorUSD || p.Tvs.Change7d == nil {
			continue
		}
		changes = append(changes, 100*(*p.Tvs.Change7d))
		c.Size++
		if p.IsUnderReview {
			c.UnderReview++
		}
		if p.Type == "layer3" {
			c.Layer3++
		}
	}
	if len(changes) < minCohort {
		return c
	}
	sort.Float64s(changes)
	n := len(changes)
	if n%2 == 1 {
		c.Median = changes[n/2]
	} else {
		c.Median = (changes[n/2-1] + changes[n/2]) / 2
	}
	c.OK = true
	return c
}

// cohort describes the reference group the excess is measured against.
// UnderReview and Layer3 are counted, not filtered: a project L2Beat is
// re-verifying still publishes the figure everyone else reads, and
// dropping it would make the yardstick a judgement rather than a
// measurement. Publishing the counts lets a reader weigh it instead.
type cohort struct {
	Median                    float64
	Size, UnderReview, Layer3 int
	OK                        bool
}

// Below this many projects a median is an accident of which few cleared
// the floor, so the harness publishes none and deletes any stale one.
const minCohort = 5

func fetchAllL2Beat(cfg *Config) {
	start := time.Now()
	summary, err := fetchL2BeatSummary()
	elapsed := float64(time.Since(start).Milliseconds())

	if err != nil {
		// One request serves every mapped chain, so one failure is a
		// failure for all of them. Attributing it to each chain keeps the
		// `chain` label meaning what it means everywhere else in this
		// harness rather than introducing a sentinel value.
		kind := classifyError(err.Error())
		for _, c := range Registry {
			if c.L2Beat != "" {
				chainKpisFetchErrors.WithLabelValues(c.Slug, "l2beat", kind).Inc()
				chainKpisHealth.WithLabelValues(c.Slug, "l2beat").Set(0)
			}
		}
		fmt.Printf("[l2beat] summary error: %v\n", err)
		return
	}

	publishL2Beat(summary, cfg, elapsed)
}

// publishL2Beat fans one cohort-wide response out over the registry rows
// that carry an L2Beat id. Split from the fetch so the mapping and the
// derived gauges are testable without reaching the network.
func publishL2Beat(summary *l2beatSummary, cfg *Config, elapsed float64) {
	co := cohortMedianChange7d(summary.Projects, cfg.L2BeatMedianFloorUSD)
	chainTvsCohortSize.Set(float64(co.Size))
	chainTvsCohortUnderReview.Set(float64(co.UnderReview))
	chainTvsCohortLayer3.Set(float64(co.Layer3))
	if co.OK {
		chainTvsCohortMedian7dPct.Set(co.Median)
	} else {
		// Delete rather than freeze: a median left at its last value would
		// keep every excess on the board looking defensible while the
		// cohort behind it no longer exists.
		chainTvsCohortMedian7dPct.Set(math.NaN())
		chainTvsChange7dExcessPct.Reset()
	}

	published, missing := 0, []string{}
	now := float64(time.Now().Unix())

	for _, c := range Registry {
		if c.L2Beat == "" {
			continue
		}
		p, found := summary.Projects[c.L2Beat]
		if !found || p.IsArchived {
			// A renamed or retired L2Beat id is a mapping bug, not a
			// transport failure: say so in the log and leave the previous
			// gauge to carry forward, as the other sources do.
			missing = append(missing, c.Slug)
			chainKpisFetchErrors.WithLabelValues(c.Slug, "l2beat", "not_tracked").Inc()
			chainKpisHealth.WithLabelValues(c.Slug, "l2beat").Set(0)
			continue
		}

		b := p.Tvs.Breakdown
		if b.Total <= 0 {
			// Same guard as the DefiLlama TVL fetch: a zero total renders
			// as a broken "$0" card rather than as "no data".
			missing = append(missing, c.Slug)
			chainKpisFetchErrors.WithLabelValues(c.Slug, "l2beat", "empty_series").Inc()
			chainKpisHealth.WithLabelValues(c.Slug, "l2beat").Set(0)
			continue
		}
		// The three origins must reconstruct the total. If upstream renames
		// one of them, every field we read silently binds to zero and the
		// board would publish a $0 bridged TVL at full health — a wrong
		// number that looks measured. A residual above a tenth of a percent
		// is not a rounding difference, it is a schema change.
		if residual := math.Abs(b.Native+b.Canonical+b.External-b.Total) / b.Total; residual > 0.001 {
			missing = append(missing, c.Slug)
			chainKpisFetchErrors.WithLabelValues(c.Slug, "l2beat", "schema_drift").Inc()
			chainKpisHealth.WithLabelValues(c.Slug, "l2beat").Set(0)
			log.Printf("[l2beat][%s] origins do not reconstruct the total (residual %.4f); not publishing", c.Slug, residual)
			continue
		}

		chainValueSecuredUsd.WithLabelValues(c.Slug, "native").Set(b.Native)
		chainValueSecuredUsd.WithLabelValues(c.Slug, "canonical").Set(b.Canonical)
		chainValueSecuredUsd.WithLabelValues(c.Slug, "external").Set(b.External)
		chainBridgedTvlUsd.WithLabelValues(c.Slug).Set(b.Canonical + b.External)
		chainTvsUsd.WithLabelValues(c.Slug).Set(b.Total)

		if p.Tvs.Change7d == nil {
			// The level is good, only the weekly move is missing. Publish
			// the balance and drop this chain's two weekly series rather
			// than printing a zero move that reads as "flat week".
			chainTvsChange7dPct.DeleteLabelValues(c.Slug)
			chainTvsChange7dExcessPct.DeleteLabelValues(c.Slug)
			chainKpisLastRefresh.WithLabelValues(c.Slug, "l2beat").Set(now)
			chainKpisHealth.WithLabelValues(c.Slug, "l2beat").Set(1)
			chainKpisFetchLatencyMs.WithLabelValues(c.Slug, "l2beat").Set(elapsed)
			published++
			continue
		}

		change := 100 * (*p.Tvs.Change7d)
		chainTvsChange7dPct.WithLabelValues(c.Slug).Set(change)
		if co.OK {
			// The absolute move is mostly the market's move. In the week
			// this was written every one of the 16 projects above $200M
			// was up, so a ranking on the raw number would have ranked
			// beta. The excess is what says a chain gained or lost ground
			// against its peers.
			chainTvsChange7dExcessPct.WithLabelValues(c.Slug).Set(change - co.Median)
		}

		chainKpisLastRefresh.WithLabelValues(c.Slug, "l2beat").Set(now)
		chainKpisHealth.WithLabelValues(c.Slug, "l2beat").Set(1)
		// One request covers the cohort, so every chain records the same
		// fetch latency. It is the latency of the call that produced this
		// chain's value, which is what the label means on the other
		// sources too.
		chainKpisFetchLatencyMs.WithLabelValues(c.Slug, "l2beat").Set(elapsed)
		published++
	}

	if published > 0 {
		// Two different clocks, and the bench reads the second one.
		//
		// LastSuccess says when our fetch last worked. SyncedUntil says
		// when L2Beat last computed a point, which today runs about 90
		// minutes behind on an hourly series. If L2Beat stalls and keeps
		// answering 200, only SyncedUntil stops moving, so that is what
		// "last measured" has to mean on the page.
		chainKpisL2BeatLastSuccessUnix.Set(now)
		if summary.Chart.SyncedUntil > 0 {
			chainKpisL2BeatSyncedUntilUnix.Set(float64(summary.Chart.SyncedUntil))
		}
		chainKpisLastTickUnix.Set(now)
	}

	fmt.Printf("[l2beat] published %d chains, cohort %d above $%.0fM (%d under review, %d layer3), median 7d %s (missing: %v)\n",
		published, co.Size, cfg.L2BeatMedianFloorUSD/1e6, co.UnderReview, co.Layer3,
		medianLabel(co), missing)
}

func medianLabel(c cohort) string {
	if !c.OK {
		return "none (cohort too small)"
	}
	return fmt.Sprintf("%+.1f%%", c.Median)
}

func fetchL2BeatSummary() (*l2beatSummary, error) {
	req, err := http.NewRequest(http.MethodGet, l2beatSummaryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "OCB-chain-kpis/1.0 (+https://openchainbench.com)")

	resp, err := httpClientL2Beat.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("l2beat: HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var out l2beatSummary
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	if len(out.Projects) == 0 {
		return nil, fmt.Errorf("l2beat: empty_series (no projects in response)")
	}
	return &out, nil
}
