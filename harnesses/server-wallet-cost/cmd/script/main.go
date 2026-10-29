package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Bench server-wallet-cost: what each vendor bills for server and agent
// wallets (a trading bot, a payout platform, a fleet of AI agents), and how
// stale that answer is.
//
// The harness holds no keys and creates no wallets. Its input is a
// committed, human-verified pricing catalogue; its work is to apply each
// vendor's own billing rules to fixed workload profiles, and to keep
// checking that the vendor's pricing page still says what the catalogue
// says.
//
// Modes:
//   default                      serve /metrics, recompute every interval
//   SERVER_WALLET_COST_EMIT_CURVES=path write the calculator's curve file and exit
//   SERVER_WALLET_COST_PIN=1            print each source's current pricing-lines
//                                hash, for a human to record after reading

func main() {
	cataloguePath := envDefault("SERVER_WALLET_COST_CATALOGUE", "pricing/catalogue.yml")
	cat, err := LoadCatalogue(cataloguePath)
	if err != nil {
		// A pricing bench with no catalogue must not look merely quiet.
		log.Fatalf("catalogue: %v", err)
	}
	log.Printf("loaded catalogue v%d as of %s: %d providers", cat.Version, cat.AsOf, len(cat.Providers))

	if out := os.Getenv("SERVER_WALLET_COST_EMIT_CURVES"); out != "" {
		if err := WriteCurves(cat, out); err != nil {
			log.Fatalf("emit curves: %v", err)
		}
		return
	}
	if os.Getenv("SERVER_WALLET_COST_PIN") != "" {
		// Prints each page's current hash and, beside it, every figure the
		// catalogue takes from that vendor that is NOT in the hashed lines:
		// a figure outside them can change without any drift.
		for _, p := range cat.Ranked() {
			for _, name := range sortedKeys(p.Source) {
				a := p.Source[name]
				r := fetchBody(a.URL, a.PinPhrases...)
				fmt.Printf("%s\t%s\t%v\t%s\tunpinned=%v\n", p.Slug, name, r.ok, r.sum, unpinnedFigures(p, r.lines))
			}
		}
		return
	}

	interval, err := time.ParseDuration(envDefault("SERVER_WALLET_COST_INTERVAL", "1h"))
	if err != nil {
		log.Fatalf("bad SERVER_WALLET_COST_INTERVAL: %v", err)
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
	costPerTx.Reset()
	eligible.Reset()
	planConfidence.Reset()
	catalogueInfo.Reset()
	catalogueInfo.WithLabelValues(cat.SHA256, cat.AsOf).Set(1)
	priceEverything(cat)
	// The prices are current as soon as they are computed; the page fetches
	// below take seconds and must not age them.
	lastRun.SetToCurrentTime()
	checkFreshness(cat)
	checkSiteCurves(cat)
	log.Print("cycle complete")
}

func priceEverything(cat *Catalogue) {
	for _, p := range cat.Ranked() {
		for _, s := range cat.Scenarios {
			for _, z := range s.Sizes {
				q := cheapest(p, s, z.X)
				// "all" on an axis is that axis's headline value, as on bench
				// 309: the unfiltered view selects kind="all",bucket="all" and
				// replaces one matcher when a reader picks a tab.
				kinds := aliasesFor(s.ID, cat.Headline.Scenario)
				buckets := aliasesFor(z.ID, cat.Headline.Size)
				tx := s.TxFix + s.TxPerX*z.X
				for _, k := range kinds {
					for _, b := range buckets {
						if !q.Eligible {
							eligible.WithLabelValues(p.Slug, k, b).Set(0)
							continue
						}
						eligible.WithLabelValues(p.Slug, k, b).Set(1)
						costMonthly.WithLabelValues(p.Slug, q.Plan, k, b).Set(q.MonthlyUSD)
						if tx > 0 {
							costPerTx.WithLabelValues(p.Slug, q.Plan, k, b).Set(q.MonthlyUSD / tx)
						}
						planConfidence.WithLabelValues(p.Slug, q.Plan, k, b).Set(boolGauge(q.Confidence == "verified"))
					}
				}
				if !q.Eligible {
					log.Printf("%s %s @%s: not priced (%s)", p.Slug, s.ID, z.ID, q.Reason)
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
	fetch := func(url string, phrases ...string) fetchResult {
		key := url + "\x00" + strings.Join(phrases, "\x00")
		if r, ok := fetched[key]; ok {
			return r
		}
		r := fetchBody(url, phrases...)
		fetched[key] = r
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

// checkSiteCurves compares the catalogue this process prices from with the
// one each site branch's calculator was built from. The calculator ships with
// the site on merge; this harness only on a VPS rebuild, and until then the
// bench page shows two prices for one vendor. A failed fetch publishes
// nothing (unknown, not mismatched); a branch without the file yet (the bench
// unreleased on main) is a 404 and publishes nothing either.
func checkSiteCurves(cat *Catalogue) {
	for _, spec := range strings.Split(envDefault("SERVER_WALLET_COST_SITE_CURVES", defaultSiteCurves), ",") {
		branch, url, ok := strings.Cut(strings.TrimSpace(spec), "=")
		if !ok || branch == "" || url == "" {
			continue
		}
		resp, err := httpClient.Get(url)
		if err != nil {
			log.Printf("site curve %s: %v", branch, err)
			continue
		}
		var f struct {
			CatalogueSHA256 string `json:"catalogueSha256"`
		}
		err = json.NewDecoder(resp.Body).Decode(&f)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || err != nil || f.CatalogueSHA256 == "" {
			log.Printf("site curve %s: HTTP %d, no catalogueSha256", branch, resp.StatusCode)
			siteCurveMatches.DeleteLabelValues(branch)
			continue
		}
		siteCurveMatches.WithLabelValues(branch).Set(boolGauge(f.CatalogueSHA256 == cat.SHA256))
	}
}

const defaultSiteCurves = "dev=https://raw.githubusercontent.com/ChainBench/OpenChainBench/dev/src/data/server-wallet-cost-curves.json," +
	"main=https://raw.githubusercontent.com/ChainBench/OpenChainBench/main/src/data/server-wallet-cost-curves.json"

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
