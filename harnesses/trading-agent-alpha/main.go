// Bench № 284. What eight frontier models earn, net of the asset they were
// pointed at.
//
// Recall Labs runs a weekly spot-trading arena on Base: eight agents, each one
// their own harness wrapped around a different frontier model, all trading the
// same ETH/USDC pair under the same rules for six days. Recall publishes a
// per-round leaderboard. This harness publishes what that leaderboard cannot.
//
// # WHY THE RAW RETURN IS NOT THE MEASUREMENT
//
// The arena is "Single Asset Trading": every agent holds some mix of ETH and
// USDC, so a round's return is mostly ETH's move. Measured over the 25 rounds
// with a real field: the correlation between the round's median agent return
// and ETH's own return is +0.81, R^2 0.66, and the agents' implied exposure is
// beta 0.43. Ranking raw returns ranks ETH weeks.
//
// So the headline here is ALPHA: the agent's compounded return minus what a
// passive position at that agent's own measured beta would have returned over
// exactly the rounds that agent was funded for. An agent is never charged for
// a round it sat out, and never credited for ETH going up.
//
// THREE DATA TRAPS, EACH OF WHICH PRODUCED A WRONG NUMBER FIRST
//
//  1. A round with pnl == 0 is usually NOT a flat trade. 88 of 90 such rows
//     carry portfolioValue == 0: the agent did not fund that round. Counting
//     them as 0 % returns dropped the hit rate from 33 % to 22 % and inflated
//     the sample from 22 rounds to 34. Only funded rounds count.
//  2. Eleven ended rounds carry ranks 1..8 and no data at all, every row zero.
//     The API serves them anyway. Publishing those ranks would be fabrication,
//     so a round needs a real field before it is scored.
//  3. The arena has had two rosters. The 32-round majority roster is the eight
//     chart/vision agents; a handful of other entries appear twice and must not
//     be averaged into the same table.
//
// # WHAT THIS DOES NOT MEASURE
//
// Recall builds these agents: "Autonomous live spot trading agent built by
// Recall Labs, powered by <model>". The prompt, the rebalancing and the
// execution are Recall's and are held constant; only the model behind them
// changes. So this measures one harness interacting with each model, never a
// model's trading ability in the abstract. The agent names are declared, not
// verified, and the spec says so on the page.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	recallAPI = "https://api.competitions.recall.network/api"
	// Coinbase's public candles need no key. The counterfactual has to come
	// from a price source outside Recall, or it would be circular.
	coinbaseAPI = "https://api.exchange.coinbase.com/products/ETH-USD/candles"

	// The arena this bench is scoped to. Deliberately one arena: durations,
	// capital and instrument differ so much across the others that a pooled
	// ranking is a property of the chosen normalisation rather than of the
	// agents. See the methodology in the spec.
	arena = "aerodrome-spot-live"

	// limit=200 answers HTTP 200 with {"success":false,"error":"Internal
	// Server Error"}. 100 is the ceiling.
	pageLimit = 100

	// A round needs a real field before it is scored, which is what excludes
	// the eleven all-zero rounds that still carry ranks.
	minFieldSize = 6
	// An agent needs a record before it is ranked. This also selects the
	// majority roster: the eight chart/vision agents have 21 to 23 funded
	// rounds, every other entry has at most three.
	minRounds = 10
)

var (
	alphaPct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_alpha_pct",
		Help: "Compounded return minus a passive position at the agent's own measured beta, over exactly the rounds it funded. The headline: what the model added once the asset is taken out.",
	}, []string{"agent", "kind", "arena"})

	returnPct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_return_pct",
		Help: "Compounded return over the rounds the agent funded. Context, not a ranking: on a single-asset arena this mostly tracks the asset.",
	}, []string{"agent", "kind", "arena"})

	passivePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_passive_pct",
		Help: "What holding the agent's own measured beta to the arena asset would have returned over the same rounds. The counterfactual the alpha is measured against.",
	}, []string{"agent", "kind", "arena"})

	assetPct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_asset_pct",
		Help: "What holding the arena asset outright would have returned over the rounds this agent funded.",
	}, []string{"agent", "kind", "arena"})

	hitRatePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_hit_rate_pct",
		Help: "Share of funded rounds finishing above zero. Funded rounds only: an unfunded round is non-participation, not a flat result.",
	}, []string{"agent", "kind", "arena"})

	beta = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_beta",
		Help: "Regression slope of the agent's round returns against the arena asset's return over the same rounds. 1.0 would be holding the asset outright.",
	}, []string{"agent", "kind", "arena"})

	rounds = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_rounds",
		Help: "Funded rounds behind this agent's figures.",
	}, []string{"agent", "kind", "arena"})

	weeklySD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_weekly_sd_pct",
		Help: "Standard deviation of the agent's weekly returns. The spread across the roster is a factor of two and a half, which a table of compounded totals hides completely.",
	}, []string{"agent", "kind", "arena"})

	alphaT = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_alpha_tstat",
		Help: "t of this agent's own weekly alpha residuals against zero. Between -2 and 2 the agent's shortfall is not distinguishable from noise on its own record.",
	}, []string{"agent", "kind", "arena"})

	// The four gauges below are ARENA-level, not per-agent, and carry the same
	// value on every agent label.
	//
	// Not an accident. The site builds a metric panel's query per provider, so
	// an arena-scope figure can only reach the page through a series that
	// exists for each one. The `asset_hold` panel already works out this way,
	// carrying two distinct values across eight agents. Each panel's
	// description says it is arena-level so the table never implies otherwise.
	pooledAlphaPct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_pooled_alpha_pct",
		Help: "ARENA-LEVEL. Mean alpha per round, averaged across the ranked roster within each round first so that one week counts once rather than eight times.",
	}, []string{"agent", "kind", "arena"})

	pooledAlphaT = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_pooled_alpha_tstat",
		Help: "ARENA-LEVEL. t of the round-level alpha series against zero. The headline finding is only significant once this passes -2.",
	}, []string{"agent", "kind", "arena"})

	roundsNeeded = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_rounds_needed_for_significance",
		Help: "ARENA-LEVEL. Rounds this effect size would need to reach t=2, holding the observed mean and dispersion. The honest answer to when we will know.",
	}, []string{"agent", "kind", "arena"})

	separableCount = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_separable_pairs",
		Help: "ARENA-LEVEL. Pairs of ranked agents whose paired weekly difference clears |t|>2. Zero means the published order is an order of finish and not a ranking.",
	}, []string{"agent", "kind", "arena"})

	// THE FAILURE MODE THIS BENCH IS MOST EXPOSED TO.
	//
	// The harness scores ENDED rounds, so a dead arena and a healthy one look
	// identical from the page: the figures simply stop moving, and the spec's
	// own methodology tells the reader that a figure which has not moved in
	// days is current rather than stale. That sentence is true while the
	// arena runs and becomes a lie the week it stops.
	//
	// Recall's own history says it will stop. hyperliquid-perps ran 9 rounds
	// and ended 2026-01-29; open-paper-trading ran 11 and ended; four other
	// arenas ran once. This one has 39 rounds and is the only one with a
	// forward schedule, which is a reason to trust it today and not a reason
	// to assume it is permanent.
	//
	// So the forward schedule is published, not just the history. Freshness
	// cannot carry this: the site noindexes a page whose data passes seven
	// days (NOINDEX_AFTER_HOURS), and a weekly arena is legitimately six days
	// stale most of the time, so wiring freshness to the round clock would
	// deindex the page every week.
	scheduledRounds = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_scheduled_rounds",
		Help: "Rounds in the arena that have not ended yet, active plus pending. Zero means the experiment is over and the published figures are a closed record, which is the one thing this bench cannot otherwise tell.",
	}, []string{"agent", "kind", "arena"})

	daysSinceRound = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_days_since_last_round",
		Help: "Days since the most recent scored round ended. Rounds are weekly, so up to 7 is normal and past 14 means two were missed.",
	}, []string{"agent", "kind", "arena"})

	tradesPerRound = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_trades_per_round",
		Help: "Trades per competition. Under identical rules the roster spans 2 to 89, a forty-fold spread in how much the same harness acts depending only on which model drives it.",
	}, []string{"agent", "kind", "arena"})

	tradesTotal = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_trades_total",
		Help: "Lifetime trades the upstream reports for this agent. Checked against /agents/{id}/competitions: 35 to 37 of each agent's rounds are this arena, so the counter is not diluted by others.",
	}, []string{"agent", "kind", "arena"})

	registeredAt = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_registered_timestamp_seconds",
		Help: "When this agent was enrolled upstream. The roster went in once, December 2025 and January 2026, and has not been refreshed since.",
	}, []string{"agent", "kind", "arena"})

	rosterAgeDays = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_roster_age_days",
		Help: "ARENA-LEVEL. Days since the MOST RECENT enrolment on the roster, i.e. how long since the field was last refreshed. A benchmark calling these agents frontier models is dating that claim, not making it about today.",
	}, []string{"agent", "kind", "arena"})

	roundsScored = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_rounds_scored",
		Help: "Rounds in the arena that carried a real field and were scored.",
	}, []string{"arena"})

	roundsSkipped = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_rounds_skipped",
		Help: "Rounds the harness refused to score, by reason. `no_field` is the eleven rounds that carry ranks and no data.",
	}, []string{"arena", "reason"})

	lastRun = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "trading_agent_last_run_timestamp_seconds",
		Help: "Unix time of the last completed pass. The arena runs weekly, so a gap of days is normal and a gap of weeks is not.",
	})

	lastRoundEnd = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "trading_agent_last_round_end_timestamp_seconds",
		Help: "End of the most recent scored round. The one alert worth having: the upstream going quiet silences this bench without breaking anything visibly.",
	}, []string{"arena"})

	errors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "trading_agent_errors_total",
		Help: "Failed upstream calls, by stage.",
	}, []string{"stage"})
)

func init() {
	for _, c := range []prometheus.Collector{
		alphaPct, returnPct, passivePct, assetPct, hitRatePct, beta,
		rounds, weeklySD, alphaT, pooledAlphaPct, pooledAlphaT,
		roundsNeeded, separableCount, scheduledRounds, daysSinceRound,
		tradesPerRound, tradesTotal, registeredAt, rosterAgeDays,
		roundsScored, roundsSkipped, lastRun, lastRoundEnd, errors,
	} {
		prometheus.MustRegister(c)
	}
}

type competition struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ArenaID   string `json:"arenaId"`
	Status    string `json:"status"`
	StartDate string `json:"startDate"`
	EndDate   string `json:"endDate"`
}

type agentRow struct {
	// ID reaches the /agents/{id} record, which carries the lifetime trade
	// counters and the wallet. Neither is on the per-competition row.
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	PortfolioValue *float64 `json:"portfolioValue"`
	PnLPercent     *float64 `json:"pnlPercent"`
}

func getJSON(url string, out any) error {
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// fetchRounds returns the arena's ended rounds that carry a real field, each
// with its funded agents, oldest first.
func fetchRounds() ([]competition, map[string][]agentRow, map[string]int, int, error) {
	var page struct {
		Success      bool          `json:"success"`
		Competitions []competition `json:"competitions"`
	}
	if err := getJSON(fmt.Sprintf("%s/competitions?limit=%d", recallAPI, pageLimit), &page); err != nil {
		errors.WithLabelValues("competitions").Inc()
		return nil, nil, nil, 0, err
	}
	// An error can arrive as HTTP 200 with success:false, which is how
	// limit=200 fails. Trust the field, not the status line.
	if !page.Success {
		errors.WithLabelValues("competitions").Inc()
		return nil, nil, nil, 0, fmt.Errorf("upstream reported success:false")
	}

	var kept []competition
	byComp := map[string][]agentRow{}
	skipped := map[string]int{}

	scheduled := 0
	for _, c := range page.Competitions {
		if c.ArenaID != arena {
			continue
		}
		if c.Status != "ended" {
			// Active or pending: not scorable, but the only evidence that the
			// arena has a future. Counting it is the difference between a
			// benchmark and an epitaph.
			scheduled++
			continue
		}
		var ap struct {
			Agents []agentRow `json:"agents"`
		}
		if err := getJSON(fmt.Sprintf("%s/competitions/%s/agents?limit=%d",
			recallAPI, c.ID, pageLimit), &ap); err != nil {
			errors.WithLabelValues("agents").Inc()
			skipped["fetch_failed"]++
			continue
		}
		var funded []agentRow
		for _, a := range ap.Agents {
			if a.PortfolioValue != nil && *a.PortfolioValue > 0 && a.PnLPercent != nil {
				funded = append(funded, a)
			}
		}
		if len(funded) < minFieldSize {
			// Trap 2: the round carries ranks and no data.
			skipped["no_field"]++
			continue
		}
		kept = append(kept, c)
		byComp[c.ID] = funded
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].EndDate < kept[j].EndDate })
	return kept, byComp, skipped, scheduled, nil
}

// ethCloses returns daily ETH-USD closes keyed by date, covering the span.
func ethCloses(from, to time.Time) (map[string]float64, error) {
	out := map[string]float64{}
	for cur := from; cur.Before(to); cur = cur.AddDate(0, 0, 200) {
		end := cur.AddDate(0, 0, 200)
		if end.After(to) {
			end = to
		}
		url := fmt.Sprintf("%s?granularity=86400&start=%s&end=%s",
			coinbaseAPI, cur.UTC().Format(time.RFC3339), end.UTC().Format(time.RFC3339))
		var rows [][]float64
		if err := getJSON(url, &rows); err != nil {
			errors.WithLabelValues("prices").Inc()
			return nil, err
		}
		for _, r := range rows {
			if len(r) >= 5 {
				d := time.Unix(int64(r[0]), 0).UTC().Format("2006-01-02")
				out[d] = r[4] // close
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no closes returned")
	}
	return out, nil
}

// closeNear walks back up to five days for a close, because the arena's bounds
// do not always land on a day with a candle.
func closeNear(closes map[string]float64, d time.Time) (float64, bool) {
	for k := 0; k < 6; k++ {
		if v, ok := closes[d.AddDate(0, 0, -k).Format("2006-01-02")]; ok {
			return v, true
		}
	}
	return 0, false
}

func parseDay(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		// Some rows carry a bare date.
		t, err = time.Parse("2006-01-02", strings.Split(s, "T")[0])
	}
	return t, err
}

// slugOf turns a declared agent name into the kebab form the site uses as a
// provider slug: "gemini 3 pro chart" -> "gemini-3-pro-chart".
//
// This is the label the `agent` series carry, and it has to be the slug rather
// than the name. The site builds a bench's metric-panel queries itself, as
// `<metric>{<label_key>="<provider slug>"}`, with no way for a spec to say the
// label holds something else. Publishing the name matched the spec's
// hand-written headline queries and nothing else, so the alpha column rendered
// while Return, Same exposure held, Winning rounds, Exposure and Rounds were
// all blank: five of the six columns the table promises, querying a label
// value that did not exist.
// A dot is DROPPED rather than turned into a separator, because a version
// number is one token: "opus 4.5 chart" is opus-45-chart and "gpt-5.2 vision"
// is gpt-52-vision, which is what the spec declares. Mapping the dot to a dash
// instead yields opus-4-5-chart and misses every slug carrying a minor
// version. TestSlugOfMatchesSpec pins all eight against the YAML.
func slugOf(name string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		case r == '.':
			// part of the token, contributes nothing
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.TrimRight(b.String(), "-")
}

// kindOf reads the input modality out of the declared agent name. The arena
// runs each model twice, once fed numeric chart data and once fed an image, so
// the modality is a real axis of the experiment rather than a naming quirk.
func kindOf(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "vision"):
		return "vision"
	case strings.Contains(n, "chart"):
		return "chart"
	default:
		return "other"
	}
}

type observation struct {
	agentPct float64
	assetPct float64
}

func compound(xs []float64) float64 {
	v := 1.0
	for _, x := range xs {
		v *= 1 + x/100
	}
	return (v - 1) * 100
}

func runOnce() error {
	comps, byComp, skipped, scheduled, err := fetchRounds()
	if err != nil {
		return err
	}
	if len(comps) == 0 {
		return fmt.Errorf("no scorable rounds in arena %s", arena)
	}

	first, err := parseDay(comps[0].StartDate)
	if err != nil {
		return fmt.Errorf("start date %q: %w", comps[0].StartDate, err)
	}
	last, err := parseDay(comps[len(comps)-1].EndDate)
	if err != nil {
		return fmt.Errorf("end date %q: %w", comps[len(comps)-1].EndDate, err)
	}
	closes, err := ethCloses(first.AddDate(0, 0, -5), last.AddDate(0, 0, 2))
	if err != nil {
		return fmt.Errorf("eth closes: %w", err)
	}

	// Per agent, the paired series it needs: its own round return and the
	// asset's return over the same round.
	obs := map[string][]observation{}
	// The same data kept ROUND-first, for the significance work. The agents
	// trade the same week, so an agent-round is not an independent
	// observation and the round has to stay addressable as a unit.
	var byRound []roundObs
	// One id per agent, for the activity lookup after the roster is known.
	agentIDs := map[string]string{}
	scored := 0
	for _, c := range comps {
		a, err1 := parseDay(c.StartDate)
		b, err2 := parseDay(c.EndDate)
		if err1 != nil || err2 != nil {
			skipped["bad_dates"]++
			continue
		}
		p0, ok0 := closeNear(closes, a)
		p1, ok1 := closeNear(closes, b)
		if !ok0 || !ok1 || p0 == 0 {
			// Without a price for the window there is no counterfactual, and
			// a round scored against no benchmark is the thing this bench
			// exists to avoid.
			skipped["no_price"]++
			continue
		}
		assetRet := 100 * (p1/p0 - 1)
		scored++
		r := roundObs{assetPct: assetRet, agents: map[string]float64{}}
		for _, row := range byComp[c.ID] {
			if row.ID != "" {
				agentIDs[row.Name] = row.ID
			}
			obs[row.Name] = append(obs[row.Name], observation{*row.PnLPercent, assetRet})
			r.agents[row.Name] = *row.PnLPercent
		}
		byRound = append(byRound, r)
	}

	alphaPct.Reset()
	returnPct.Reset()
	passivePct.Reset()
	assetPct.Reset()
	hitRatePct.Reset()
	beta.Reset()
	rounds.Reset()
	weeklySD.Reset()
	alphaT.Reset()
	pooledAlphaPct.Reset()
	pooledAlphaT.Reset()
	roundsNeeded.Reset()
	separableCount.Reset()
	scheduledRounds.Reset()
	daysSinceRound.Reset()
	tradesPerRound.Reset()
	tradesTotal.Reset()
	registeredAt.Reset()
	rosterAgeDays.Reset()
	roundsSkipped.Reset()

	// Betas are needed by the pooled test, which cannot run until every
	// agent has one, so they are collected here and the significance block
	// runs after the loop.
	betas := map[string]float64{}
	var ranked []string

	published := 0
	for name, o := range obs {
		if len(o) < minRounds {
			// Trap 3: the minority roster, two or three rounds each, must not
			// be averaged into the same table.
			continue
		}
		var ag, as []float64
		wins := 0
		for _, x := range o {
			ag = append(ag, x.agentPct)
			as = append(as, x.assetPct)
			if x.agentPct > 0 {
				wins++
			}
		}
		// Beta against the asset over this agent's own rounds.
		var mx, my float64
		for i := range ag {
			mx += as[i]
			my += ag[i]
		}
		mx /= float64(len(ag))
		my /= float64(len(ag))
		var cov, varx float64
		for i := range ag {
			cov += (as[i] - mx) * (ag[i] - my)
			varx += (as[i] - mx) * (as[i] - mx)
		}
		b := 0.0
		if varx > 0 {
			b = cov / varx
		}
		// The passive counterfactual: the agent's own beta, applied round by
		// round, compounded over exactly its own rounds.
		passive := make([]float64, len(as))
		for i, x := range as {
			passive[i] = b * x
		}

		betas[name] = b
		ranked = append(ranked, name)

		agentRet := compound(ag)
		passiveRet := compound(passive)
		// Every figure is published TWICE: once under the agent's real input
		// modality and once under kind="all".
		//
		// Not redundancy. The site replaces a selector only when it is pinned
		// to ="all" and leaves any other form alone, so without the pooled
		// series the default tab renders empty, and a spec that pinned a real
		// modality instead would show an unfiltered number under a filtered
		// label.
		for _, k := range []string{kindOf(name), "all"} {
			lbl := []string{slugOf(name), k, arena}
			alphaPct.WithLabelValues(lbl...).Set(agentRet - passiveRet)
			returnPct.WithLabelValues(lbl...).Set(agentRet)
			passivePct.WithLabelValues(lbl...).Set(passiveRet)
			assetPct.WithLabelValues(lbl...).Set(compound(as))
			hitRatePct.WithLabelValues(lbl...).Set(100 * float64(wins) / float64(len(ag)))
			beta.WithLabelValues(lbl...).Set(b)
			rounds.WithLabelValues(lbl...).Set(float64(len(ag)))
			// Dispersion, and whether this agent's own shortfall clears its
			// own noise. A compounded total hides both.
			if v := sd(ag); !math.IsNaN(v) {
				weeklySD.WithLabelValues(lbl...).Set(v)
			}
			if t := tStat(agentAlphaSeries(name, byRound, b)); !math.IsNaN(t) {
				alphaT.WithLabelValues(lbl...).Set(t)
			}
		}
		published++

		log.Printf("[284] %-22s n=%2d beta=%+.2f return=%+7.2f%% passive=%+7.2f%% alpha=%+7.2f%% hit=%.0f%%",
			name, len(ag), b, agentRet, passiveRet, agentRet-passiveRet,
			100*float64(wins)/float64(len(ag)))
	}

	// Significance, after the loop because the pooled test needs every beta.
	//
	// This is the part the page was missing. It ranked eight agents over a
	// nineteen-point spread with nothing saying whether the order means
	// anything, and it does not: on the paired weekly differences no two
	// agents here are separable. The headline shortfall is real in sign and
	// not yet significant in size. Publishing those two facts next to the
	// table is the difference between a benchmark and a leaderboard.
	if len(ranked) >= 2 && len(byRound) >= 3 {
		series := pooledAlpha(byRound, betas)
		pm, pt := mean(series), tStat(series)
		need := roundsForT2(series)
		sep, tested, maxT := separablePairs(ranked, byRound)

		for _, name := range ranked {
			for _, k := range []string{kindOf(name), "all"} {
				lbl := []string{slugOf(name), k, arena}
				if !math.IsNaN(pm) {
					pooledAlphaPct.WithLabelValues(lbl...).Set(pm)
				}
				if !math.IsNaN(pt) {
					pooledAlphaT.WithLabelValues(lbl...).Set(pt)
				}
				if !math.IsNaN(need) {
					roundsNeeded.WithLabelValues(lbl...).Set(need)
				}
				separableCount.WithLabelValues(lbl...).Set(float64(sep))
			}
		}
		log.Printf("[284] significance: pooled alpha %+.3f%%/round t=%+.2f over %d rounds, "+
			"needs %.0f for t=2; %d of %d pairs separable (max |t| %.2f)",
			pm, pt, len(series), need, sep, tested, maxT)
	}

	// Trading activity. One extra request per ranked agent, after the roster
	// is settled so we never fetch a detail record for an entry that will not
	// be published.
	wanted := map[string]string{}
	for _, name := range ranked {
		if id, ok := agentIDs[name]; ok {
			wanted[name] = id
		}
	}
	acts := fetchActivity(wanted)
	// The newest enrolment, which is how long since the field was refreshed.
	// Newest rather than oldest: one agent added yesterday would make the
	// roster current, and the oldest date would hide that.
	var newest time.Time
	for name, act := range acts {
		for _, k := range []string{kindOf(name), "all"} {
			lbl := []string{slugOf(name), k, arena}
			tradesPerRound.WithLabelValues(lbl...).Set(act.tradesPerRound)
			tradesTotal.WithLabelValues(lbl...).Set(act.totalTrades)
			if !act.registered.IsZero() {
				registeredAt.WithLabelValues(lbl...).Set(float64(act.registered.Unix()))
			}
		}
		if act.registered.After(newest) {
			newest = act.registered
		}
		log.Printf("[284] %-22s %7.0f trades, %6.2f per round, enrolled %s, wallet %s",
			name, act.totalTrades, act.tradesPerRound,
			act.registered.Format("2006-01-02"), act.wallet)
	}
	if !newest.IsZero() {
		age := time.Since(newest).Hours() / 24
		for _, name := range ranked {
			for _, k := range []string{kindOf(name), "all"} {
				rosterAgeDays.WithLabelValues(slugOf(name), k, arena).Set(age)
			}
		}
		log.Printf("[284] roster: last enrolled %s, %.0f days ago",
			newest.Format("2006-01-02"), age)
	}

	// Liveness, published per agent for the same reason the arena-level
	// statistics are: the site builds a panel query per provider, so this is
	// the only route an arena-scope figure has to the page.
	var daysSince float64 = -1
	if t, err := parseDay(comps[len(comps)-1].EndDate); err == nil {
		daysSince = time.Since(t).Hours() / 24
	}
	for _, name := range ranked {
		for _, k := range []string{kindOf(name), "all"} {
			lbl := []string{slugOf(name), k, arena}
			scheduledRounds.WithLabelValues(lbl...).Set(float64(scheduled))
			if daysSince >= 0 {
				daysSinceRound.WithLabelValues(lbl...).Set(daysSince)
			}
		}
	}
	if scheduled == 0 {
		// Loud on purpose. Every published figure is still correct; what has
		// changed is that they are now a closed record rather than a running
		// experiment, and the page's copy has to move to the past tense.
		log.Printf("[284] WARNING arena %s has no active or pending round: "+
			"the experiment appears to be over (last round ended %.0f days ago). "+
			"The figures stay valid as history; the page's copy does not.",
			arena, daysSince)
	} else {
		log.Printf("[284] arena liveness: %d rounds scheduled, last ended %.1f days ago",
			scheduled, daysSince)
	}

	roundsScored.WithLabelValues(arena).Set(float64(scored))
	for reason, n := range skipped {
		roundsSkipped.WithLabelValues(arena, reason).Set(float64(n))
	}
	if t, err := parseDay(comps[len(comps)-1].EndDate); err == nil {
		lastRoundEnd.WithLabelValues(arena).Set(float64(t.Unix()))
	}
	lastRun.Set(float64(time.Now().Unix()))

	log.Printf("[284] pass complete: %d agents published, %d rounds scored, skipped %v",
		published, scored, skipped)
	if published == 0 {
		return fmt.Errorf("no agent met the %d-round floor", minRounds)
	}
	return nil
}

func main() {
	poll := 3600
	if v := os.Getenv("POLL_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 300 {
			poll = n
		}
	}
	log.Printf("[284] trading-agent-alpha starting, arena=%s poll=%ds", arena, poll)

	go func() {
		for {
			if err := runOnce(); err != nil {
				log.Printf("[284] pass failed: %v", err)
			}
			time.Sleep(time.Duration(poll) * time.Second)
		}
	}()

	http.Handle("/metrics", promhttp.Handler())
	addr := ":2115"
	log.Printf("[284] serving %s/metrics", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
