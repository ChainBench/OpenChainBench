package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Bench wallet-cost: what each embedded wallet provider bills for the same
// app, and how stale that answer is.
//
// The harness holds no keys and creates no wallets. Its input is a
// committed, human-verified pricing catalogue; its work is to apply each
// vendor's own billing rules to fixed workload profiles, and to keep
// checking that the vendor's pricing page still says what the catalogue
// says.
//
// Modes:
//   default                      serve /metrics, recompute every interval
//   WALLET_COST_EMIT_CURVES=path write the calculator's curve file and exit
//   WALLET_COST_PIN=1            print each source's current pricing-lines
//                                hash, for a human to record after reading

func main() {
	cataloguePath := envDefault("WALLET_COST_CATALOGUE", "pricing/catalogue.yml")
	cat, err := LoadCatalogue(cataloguePath)
	if err != nil {
		// A pricing bench with no catalogue must not look merely quiet.
		log.Fatalf("catalogue: %v", err)
	}
	log.Printf("loaded catalogue v%d as of %s: %d providers", cat.Version, cat.AsOf, len(cat.Providers))

	if out := os.Getenv("WALLET_COST_EMIT_CURVES"); out != "" {
		if err := WriteCurves(cat, out); err != nil {
			log.Fatalf("emit curves: %v", err)
		}
		return
	}
	if os.Getenv("WALLET_COST_PIN") != "" {
		for _, p := range cat.Providers {
			for _, name := range sortedKeys(p.Source) {
				a := p.Source[name]
				r := fetchBody(a.URL)
				fmt.Printf("%s\t%s\t%v\t%s\n", p.Slug, name, r.ok, r.sum)
			}
		}
		return
	}

	interval, err := time.ParseDuration(envDefault("WALLET_COST_INTERVAL", "1h"))
	if err != nil {
		log.Fatalf("bad WALLET_COST_INTERVAL: %v", err)
	}
	go serve(envDefault("PORT", "2112"))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	run(cat)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
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
	// Withdrawn series must disappear: a gauge keeps its last value forever,
	// so a plan that stops qualifying would otherwise keep its price on the
	// page.
	costMonthly.Reset()
	costPerUser.Reset()
	eligible.Reset()
	planConfidence.Reset()
	catalogueInfo.Reset()
	catalogueInfo.WithLabelValues(cat.SHA256, cat.AsOf).Set(1)
	priceEverything(cat)
	checkFreshness(cat)
	lastRun.SetToCurrentTime()
	log.Print("cycle complete")
}

func priceEverything(cat *Catalogue) {
	for _, p := range cat.Ranked() {
		for _, pr := range cat.Profiles {
			for _, v := range cat.Volumes {
				q := cheapest(p, pr, v.MAU)
				// "all" on an axis means that axis's headline value, the same
				// convention rpc-cost uses: the site's unfiltered view selects
				// kind="all",bucket="all" and REPLACES one matcher when a reader
				// picks a tab, so (trading, all) must exist and mean trading at
				// the headline volume. Averaging bills across profiles or
				// volumes would describe no workload at all.
				kinds := aliasesFor(pr.ID, cat.Headline.Profile)
				buckets := aliasesFor(v.ID, cat.Headline.Volume)
				for _, k := range kinds {
					for _, b := range buckets {
						if !q.Eligible {
							eligible.WithLabelValues(p.Slug, k, b).Set(0)
							continue
						}
						eligible.WithLabelValues(p.Slug, k, b).Set(1)
						costMonthly.WithLabelValues(p.Slug, q.Plan, k, b).Set(q.MonthlyUSD)
						costPerUser.WithLabelValues(p.Slug, q.Plan, k, b).Set(q.MonthlyUSD / v.MAU)
						planConfidence.WithLabelValues(p.Slug, q.Plan, k, b).Set(boolGauge(q.Confidence == "verified"))
					}
				}
				if !q.Eligible {
					log.Printf("%s %s @%s: not priced (%s)", p.Slug, pr.ID, v.ID, q.Reason)
				}
			}
		}
	}
}

// lastDrift keeps each page's verdict across cycles, so a drifted page that
// then fails to load keeps its alarm, which is when it most needs a human.
var lastDrift = map[string]bool{}

func checkFreshness(cat *Catalogue) {
	// Fetch everything first and publish afterwards: resetting the gauges
	// before thirteen page loads left a scrape landing in that window with
	// no artifact series at all, which reads as "not monitored".
	type reading struct {
		slug, name string
		st         artifactState
	}
	var readings []reading
	fetched := map[string]fetchResult{}
	fetch := func(url string) fetchResult {
		if r, ok := fetched[url]; ok {
			return r
		}
		r := fetchBody(url)
		fetched[url] = r
		return r
	}
	for _, p := range cat.Ranked() {
		for _, name := range sortedKeys(p.Source) {
			readings = append(readings, reading{p.Slug, name, checkArtifact(p.Source[name], fetch)})
		}
	}
	artifactOK.Reset()
	artifactAge.Reset()
	// artifactDrift is not reset: lastDrift re-publishes every known
	// verdict, including through a failed fetch.
	for _, r := range readings {
		key := r.slug + "/" + r.name
		if r.st.polled {
			artifactOK.WithLabelValues(r.slug, r.name).Set(boolGauge(r.st.ok))
			if r.st.ok {
				lastDrift[key] = r.st.drift
			}
			if d, known := lastDrift[key]; known {
				artifactDrift.WithLabelValues(r.slug, r.name).Set(boolGauge(d))
			}
		}
		if r.st.age > 0 {
			artifactAge.WithLabelValues(r.slug, r.name).Set(r.st.age.Seconds())
		}
	}
}

func serve(port string) {
	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	log.Printf("serving /metrics on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func envDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// aliasesFor returns the label values a series is published under: its own,
// plus "all" when it is the headline value of its axis.
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
