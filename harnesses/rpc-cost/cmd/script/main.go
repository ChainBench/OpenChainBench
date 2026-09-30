package main

import (
	"log"
	"math"
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
	priceEverything(cat)
	checkFreshness(cat)
	lastRun.SetToCurrentTime()
	log.Printf("cycle complete")
}

func priceEverything(cat *Catalogue) {
	// The cheapest metered rate across the usage cohort, used as the
	// denominator for the dedicated cohort's break-even. Computed from
	// the simple-read profile at the largest bucket, which is the rate a
	// high-volume buyer would actually be quoted.
	meteredFloor := math.Inf(1)

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
		for _, pr := range Profiles {
			if upr, err := unitsPerRequest(p, pr); err == nil {
				unitsPerReq.WithLabelValues(p.Slug, pr.ID, pr.Chain).Set(upr)
			}

			// Free tiers cannot be ranked on price, so they get their own
			// axis: how many requests of this exact workload the allowance
			// buys. "200M credits" is meaningless until it is divided by
			// what a credit buys.
			if reqs, planID, ok := cat.FreeAllowanceRequests(p, pr); ok {
				freeAllowance.WithLabelValues(p.Slug, planID, pr.ID, pr.Chain).Set(reqs)
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
						if cohort == "usage" && pr.ID == "simple-read" && b.ID == "1000m" && q.PerMillionUSD < meteredFloor {
							meteredFloor = q.PerMillionUSD
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

	if math.IsInf(meteredFloor, 1) {
		return
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
			breakevenReqs.WithLabelValues(p.Slug, pl.ID, "ethereum").Set(breakeven(monthly, meteredFloor))
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
			artifactOK.WithLabelValues(p.Slug, name).Set(boolGauge(st.ok))
			artifactDrift.WithLabelValues(p.Slug, name).Set(boolGauge(st.drift))
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

