package main

import (
	"encoding/json"
	"fmt"
	"io"
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
type l2beatProject struct {
	Name       string `json:"name"`
	IsArchived bool   `json:"isArchived"`
	Tvs        struct {
		Breakdown struct {
			Total     float64 `json:"total"`
			Native    float64 `json:"native"`
			Canonical float64 `json:"canonical"`
			External  float64 `json:"external"`
		} `json:"breakdown"`
		// Change7d is a ratio, not a percentage: 0.152 means +15.2%.
		Change7d float64 `json:"change7d"`
	} `json:"tvs"`
}

type l2beatSummary struct {
	Projects map[string]l2beatProject `json:"projects"`
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
func cohortMedianChange7d(projects map[string]l2beatProject, floorUSD float64) (median float64, size int, ok bool) {
	changes := []float64{}
	for _, p := range projects {
		if p.IsArchived || p.Tvs.Breakdown.Total < floorUSD {
			continue
		}
		changes = append(changes, 100*p.Tvs.Change7d)
	}
	if len(changes) < 5 {
		return 0, len(changes), false
	}
	sort.Float64s(changes)
	n := len(changes)
	if n%2 == 1 {
		return changes[n/2], n, true
	}
	return (changes[n/2-1] + changes[n/2]) / 2, n, true
}

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
	median, cohortSize, haveMedian := cohortMedianChange7d(summary.Projects, cfg.L2BeatMedianFloorUSD)
	chainTvsCohortSize.Set(float64(cohortSize))
	if haveMedian {
		chainTvsCohortMedian7dPct.Set(median)
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

		chainValueSecuredUsd.WithLabelValues(c.Slug, "native").Set(b.Native)
		chainValueSecuredUsd.WithLabelValues(c.Slug, "canonical").Set(b.Canonical)
		chainValueSecuredUsd.WithLabelValues(c.Slug, "external").Set(b.External)
		chainBridgedTvlUsd.WithLabelValues(c.Slug).Set(b.Canonical + b.External)
		chainTvsUsd.WithLabelValues(c.Slug).Set(b.Total)

		change := 100 * p.Tvs.Change7d
		chainTvsChange7dPct.WithLabelValues(c.Slug).Set(change)
		if haveMedian {
			// The absolute move is mostly the market's move. In the week
			// this was written every one of the 16 projects above $200M
			// was up, from +3.6% to +23.6% with a median of +14.8%, so a
			// ranking on the raw number would have ranked beta. The excess
			// is what says a chain gained or lost ground against its peers.
			chainTvsChange7dExcessPct.WithLabelValues(c.Slug).Set(change - median)
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

	fmt.Printf("[l2beat] published %d chains, cohort %d above $%.0fM, median 7d %+.1f%% (missing: %v)\n",
		published, cohortSize, cfg.L2BeatMedianFloorUSD/1e6, median, missing)
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
