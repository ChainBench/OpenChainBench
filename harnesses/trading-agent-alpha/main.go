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
		rounds, roundsScored, roundsSkipped, lastRun, lastRoundEnd, errors,
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
func fetchRounds() ([]competition, map[string][]agentRow, map[string]int, error) {
	var page struct {
		Success      bool          `json:"success"`
		Competitions []competition `json:"competitions"`
	}
	if err := getJSON(fmt.Sprintf("%s/competitions?limit=%d", recallAPI, pageLimit), &page); err != nil {
		errors.WithLabelValues("competitions").Inc()
		return nil, nil, nil, err
	}
	// An error can arrive as HTTP 200 with success:false, which is how
	// limit=200 fails. Trust the field, not the status line.
	if !page.Success {
		errors.WithLabelValues("competitions").Inc()
		return nil, nil, nil, fmt.Errorf("upstream reported success:false")
	}

	var kept []competition
	byComp := map[string][]agentRow{}
	skipped := map[string]int{}

	for _, c := range page.Competitions {
		if c.ArenaID != arena || c.Status != "ended" {
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
	return kept, byComp, skipped, nil
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
	comps, byComp, skipped, err := fetchRounds()
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
		for _, row := range byComp[c.ID] {
			obs[row.Name] = append(obs[row.Name], observation{*row.PnLPercent, assetRet})
		}
	}

	alphaPct.Reset()
	returnPct.Reset()
	passivePct.Reset()
	assetPct.Reset()
	hitRatePct.Reset()
	beta.Reset()
	rounds.Reset()
	roundsSkipped.Reset()

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
			lbl := []string{name, k, arena}
			alphaPct.WithLabelValues(lbl...).Set(agentRet - passiveRet)
			returnPct.WithLabelValues(lbl...).Set(agentRet)
			passivePct.WithLabelValues(lbl...).Set(passiveRet)
			assetPct.WithLabelValues(lbl...).Set(compound(as))
			hitRatePct.WithLabelValues(lbl...).Set(100 * float64(wins) / float64(len(ag)))
			beta.WithLabelValues(lbl...).Set(b)
			rounds.WithLabelValues(lbl...).Set(float64(len(ag)))
		}
		published++

		log.Printf("[284] %-22s n=%2d beta=%+.2f return=%+7.2f%% passive=%+7.2f%% alpha=%+7.2f%% hit=%.0f%%",
			name, len(ag), b, agentRet, passiveRet, agentRet-passiveRet,
			100*float64(wins)/float64(len(ag)))
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
