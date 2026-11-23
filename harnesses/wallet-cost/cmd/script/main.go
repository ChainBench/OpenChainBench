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
		// Prints each page's current hash and, beside it, every figure the
		// catalogue takes from that vendor that is NOT in the hashed lines:
		// a figure outside them can change without any drift.
		for _, p := range cat.Ranked() {
			for _, name := range sortedKeys(p.Source) {
				a := p.Source[name]
				r := fetchBody(a.URL, a.PinPhrases...)
				fmt.Printf("%s\t%s\t%v\t%s\tunpinned=%v\tstray=%v\n", p.Slug, name, r.ok, r.sum, unpinnedFigures(p, r.lines), strayFigures(p, r.lines))
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
	// The site curves are re-read far more often than the prices: a release
	// that ships a new catalogue to one branch opens a window where the two
	// sites price from different catalogues, and an hourly check with a 2h
	// alert could not see the 30 minutes production spent that way on
	// 2026-10-30 (audit). The fetch is two small raw files.
	siteEvery, err := time.ParseDuration(envDefault("WALLET_COST_SITE_CURVES_INTERVAL", "5m"))
	if err != nil {
		log.Fatalf("bad WALLET_COST_SITE_CURVES_INTERVAL: %v", err)
	}
	siteTicker := time.NewTicker(siteEvery)
	defer siteTicker.Stop()
	for {
		select {
		case <-siteTicker.C:
			checkSiteCurves(cat)
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
	// The prices are current as soon as they are computed; the page fetches
	// below take seconds and must not age them.
	lastRun.SetToCurrentTime()
	checkFreshness(cat)
	checkSiteCurves(cat)
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
	// A page the catalogue no longer polls (a vendor removed, a source
	// renamed or poll turned off) must not keep its last drift verdict, or
	// its alert would fire forever for a page nobody prices from.
	polled := map[string]bool{}
	for _, r := range readings {
		if r.st.polled {
			polled[r.slug+"/"+r.name] = true
		}
	}
	for key := range lastDrift {
		if !polled[key] {
			slug, name, _ := strings.Cut(key, "/")
			artifactDrift.DeleteLabelValues(slug, name)
			delete(lastDrift, key)
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
	for _, spec := range strings.Split(envDefault("WALLET_COST_SITE_CURVES", defaultSiteCurves), ",") {
		branch, url, ok := strings.Cut(strings.TrimSpace(spec), "=")
		if !ok || branch == "" || url == "" {
			continue
		}
		resp, err := httpClient.Get(url)
		if err != nil {
			// Publish nothing rather than last cycle's verdict: a stale 1
			// would keep the mismatch alert quiet through an outage.
			log.Printf("site curve %s: %v", branch, err)
			siteCurveMatches.DeleteLabelValues(branch)
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

const defaultSiteCurves = "dev=https://raw.githubusercontent.com/ChainBench/OpenChainBench/dev/src/data/wallet-cost-curves.json," +
	"main=https://raw.githubusercontent.com/ChainBench/OpenChainBench/main/src/data/wallet-cost-curves.json"

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
