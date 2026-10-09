package main

import (
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Bench rpc-cost — what each RPC provider actually bills for a given
// workload, and how stale that answer is.
//
// The harness holds no API keys and sends no RPC traffic. Its input is a
// committed, human-verified pricing catalogue; its work is to apply each
// provider's own billing rules to a set of workload profiles, and to
// keep checking that the upstream pricing artifacts still say what the
// catalogue claims they say.

func main() {
	cataloguePath := envDefault("RPC_COST_CATALOGUE", "pricing/catalogue.yml")
	port := envDefault("PORT", "2112")
	interval, err := time.ParseDuration(envDefault("RPC_COST_INTERVAL", "1h"))
	if err != nil {
		log.Fatalf("bad RPC_COST_INTERVAL: %v", err)
	}

	// Fail loudly at boot rather than serving an empty /metrics: a
	// pricing bench with no catalogue should not look merely quiet.
	cat, err := LoadCatalogue(cataloguePath)
	if err != nil {
		log.Fatalf("catalogue: %v", err)
	}
	log.Printf("loaded catalogue version %d as of %s: %d providers", cat.Version, cat.AsOf, len(cat.Providers))

	// One-shot mode: write the cost curves and exit. The site reads that
	// artifact to draw a slider over any request count, instead of the
	// three volumes the gauges publish. It is generated from this process
	// so the slider and the gauges cannot drift apart: both go through
	// cheapest(). See curve.go.
	if out := os.Getenv("RPC_COST_EMIT_CURVES"); out != "" {
		if err := WriteCurves(cat, out); err != nil {
			log.Fatalf("emit curves: %v", err)
		}
		return
	}

	go serve(port)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	run(cat)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			// Re-read from disk so a catalogue correction lands on the next
			// cycle without a redeploy.
			if fresh, err := LoadCatalogue(cataloguePath); err != nil {
				log.Printf("catalogue reload failed, keeping previous: %v", err)
			} else {
				cat = fresh
			}
			run(cat)
		case <-stop:
			log.Print("shutting down")
			return
		}
	}
}

func run(cat *Catalogue) {
	// Clear every gauge before recomputing. Without this a provider that
	// stops being eligible, or a plan that leaves the catalogue, keeps
	// exporting its last value forever: Prometheus cannot know the series
	// was withdrawn, and the page would quote a price the model no longer
	// stands behind.
	costMonthly.Reset()
	costPerMillion.Reset()
	freeAllowance.Reset()
	freeFloor.Reset()
	freeCeiling.Reset()
	planConfidence.Reset()
	unitsPerReq.Reset()
	eligible.Reset()
	breakevenReqs.Reset()
	artifactOK.Reset()
	artifactAge.Reset()
	artifactDrift.Reset()

	priceEverything(cat)
	checkFreshness(cat)
	lastRun.SetToCurrentTime()
	log.Printf("cycle complete")
}

func priceEverything(cat *Catalogue) {
	// The cheapest metered rate across the usage cohort, per chain, used
	// as the denominator for the dedicated cohort's break-even. Computed
	// from the simple-read profile at the largest bucket, the rate a
	// high-volume buyer would actually be quoted. Per chain because a
	// Solana node compared against an Ethereum rate answers a question
	// nobody asked: every break-even used to be labelled ethereum,
	// including the ones for Solana-only nodes.
	meteredFloor := map[string]float64{}

	for _, p := range cat.Providers {
		if p.Cohort == "excluded" {
			continue
		}
		// Reference rows are real and usable but not purchasable, so they
		// are published under their own cohort and never compete for the
		// leaderboard. PublicNode at $0 is the honest floor of the market
		// and a meaningless winner: it publishes no rate limit at all.
		cohort := p.Cohort
		if p.Ranked != nil && !*p.Ranked {
			cohort = "reference"
		}
		// One pass over the profiles before publishing any of them: the
		// floor and the ceiling of this plan's allowance are properties of
		// the whole workload set, not of the profile being priced, so they
		// cannot be computed inside the loop that publishes them.
		envelopes := cat.FreeEnvelopes(p)

		for _, pr := range Profiles {
			if upr, err := unitsPerRequest(p, pr); err == nil {
				unitsPerReq.WithLabelValues(p.Slug, pr.ID, pr.Chain).Set(upr)
			}

			// Free tiers cannot be ranked on price, so they get their own
			// axis: how many requests of this exact workload the allowance
			// buys. "200M credits" is meaningless until it is divided by
			// what a credit buys.
			if reqs, planID, ok := cat.FreeAllowanceRequests(p, pr); ok {
				// Published under the real labels and under the `all`
				// aliases the unfiltered view selects. Without the aliases a
				// reader switching tabs changes nothing, because injectLabels
				// only replaces a selector pinned to `="all"`, and the
				// default view spans every combination instead of one slice.
				//
				// `all` is the headline slice, not a pooled average: an
				// allowance in requests depends on what a request costs in
				// units, so averaging the dapp mix with a trace mix would
				// describe no workload at all. The dimension label says so.
				//
				// Only `kind` is aliased, never `chain`. A profile already
				// belongs to one chain (simple-read, dapp, indexer and trace
				// are Ethereum, solana-bot is Solana), so a chain axis beside
				// the workload axis offers combinations that cannot exist and
				// a chain alias makes `kind="all"` match two chains at once.
				//
				// The floor and the ceiling ride the same labels as the
				// allowance, carrying the span of this chain's workloads
				// under each one. A reader on the trace tab then sees that
				// BlockPI's 368k is the bottom of a range reaching 3.1M,
				// and a reader on the dapp tab sees that Ankr's 1M is the
				// whole range. Neither fact is readable from one figure.
				env := envelopes[pr.Chain]
				for _, ka := range aliasesFor(pr.ID, headlineKind) {
					freeAllowance.WithLabelValues(p.Slug, planID, ka, pr.Chain).Set(reqs)
					freeFloor.WithLabelValues(p.Slug, planID, ka, pr.Chain).Set(env.Lo)
					freeCeiling.WithLabelValues(p.Slug, planID, ka, pr.Chain).Set(env.Hi)
				}
			}

			for _, b := range Buckets {
				for _, tier := range PlanTiers {
					filter := tier
					q := cheapest(cat, p, pr, b.Requests, filter)
					if !q.Eligible {
						if tier == "all" {
							for _, ka := range aliasesFor(pr.ID, headlineKind) {
								for _, ba := range aliasesFor(b.ID, headlineBucket) {
									eligible.WithLabelValues(p.Slug, ka, ba).Set(0)
								}
							}
							log.Printf("%s %s @%s: not ranked (%s)", p.Slug, pr.ID, b.ID, q.Reason)
						}
						continue
					}
					if tier == "all" {
						for _, ka := range aliasesFor(pr.ID, headlineKind) {
							for _, ba := range aliasesFor(b.ID, headlineBucket) {
								eligible.WithLabelValues(p.Slug, ka, ba).Set(1)
							}
						}
						if cohort == "usage" && pr.ID == baselineProfile(pr.Chain) && b.ID == "1000m" {
							if cur, ok := meteredFloor[pr.Chain]; !ok || q.PerMillionUSD < cur {
								meteredFloor[pr.Chain] = q.PerMillionUSD
							}
						}
					}
					if tier == "all" {
						planConfidence.WithLabelValues(p.Slug, q.Plan, pr.ID, b.ID).Set(boolGauge(q.Confidence == "verified"))
					}
					// The site's unfiltered view selects `kind="all"` and
					// `bucket="all"` and REPLACES those matchers when a reader
					// picks a tab (injectLabels treats a pinned "all" as the
					// pooled form). Pooling a cost across profiles and volumes
					// would be meaningless -- averaging a $24 bill with a
					// $10,500 one -- so the pooled series is the headline
					// slice instead, and the dimension labels on the page name
					// it honestly rather than saying "all".
					for _, ka := range aliasesFor(pr.ID, headlineKind) {
						for _, ba := range aliasesFor(b.ID, headlineBucket) {
							costMonthly.WithLabelValues(p.Slug, q.Plan, ka, ba, pr.Chain, cohort, tier).Set(q.MonthlyUSD)
							costPerMillion.WithLabelValues(p.Slug, q.Plan, ka, ba, pr.Chain, cohort, tier).Set(q.PerMillionUSD)
						}
					}
				}
			}
		}
	}

	for _, p := range cat.Providers {
		if p.Cohort != "dedicated" {
			continue
		}
		for _, pl := range p.Plans {
			if pl.MonthlyUSD == nil {
				continue
			}
			monthly := cat.toUSD(*pl.MonthlyUSD, p.Currency)
			// One series per chain the plan actually serves, against that
			// chain's own metered floor.
			for _, ch := range pl.Chains {
				floor, ok := meteredFloor[ch]
				if !ok {
					continue
				}
				breakevenReqs.WithLabelValues(p.Slug, pl.ID, ch).Set(breakeven(monthly, floor))
			}
		}
	}
}

func checkFreshness(cat *Catalogue) {
	for _, p := range cat.Providers {
		if p.Cohort == "excluded" {
			continue
		}
		for name, a := range p.Source {
			st := checkArtifact(a)
			if st.polled {
				artifactOK.WithLabelValues(p.Slug, name).Set(boolGauge(st.ok))
				artifactDrift.WithLabelValues(p.Slug, name).Set(boolGauge(st.drift))
			}
			if st.age > 0 {
				artifactAge.WithLabelValues(p.Slug, name).Set(st.age.Seconds())
			}
		}
	}
}

func serve(port string) {
	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	addr := ":" + port
	log.Printf("serving /metrics on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func envDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// aliasesFor returns the label values a series should be published under:
// its own, plus "all" when it is the headline slice the unfiltered view
// selects.
func aliasesFor(value, headline string) []string {
	if value == headline {
		return []string{value, "all"}
	}
	return []string{value}
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
