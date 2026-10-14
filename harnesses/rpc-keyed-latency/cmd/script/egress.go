package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Does this probe actually sit where its label claims?
//
// Every sample is published under region="sgp" or "us-east" or "eu-west", but
// that label is our claim about the container, not a measurement of where the
// traffic comes from. On 2026-10-14 the Singapore container egressed through a
// Railway IP registered in San Francisco (152.55.188.14). Four of the six
// providers pick a point of presence from the client IP, so they answered from
// the United States — correctly, from their side — and we published ~200 ms
// under the label "Singapore" for about ninety minutes. It happened twice that
// day, both times after a deploy, because each new container drew a new egress
// IP and only some of Railway's blocks are registered in Asia.
//
// The two providers that did not move say why this matters and why it will
// recur: GetBlock puts the region in the hostname and QuickNode uses anycast,
// so neither consults the client IP. Everyone else must, and will keep
// trusting the registry over our label.
//
// Static outbound IPs now pin the Singapore egress, which removes the draw but
// not the class of bug: the pinned addresses are shared rather than dedicated,
// the other two regions are not pinned, and a registry entry can change under
// us at any time. Nothing in the pipeline would notice. This does.
//
// Two rules shape the implementation. Fail open: a third-party geolocation
// service being unreachable must never stop a measurement, so an inconclusive
// lookup changes nothing. Fail loud, and only on agreement: suppression needs
// two independent sources naming the same country, that country on the wrong
// continent, twice in a row. Blanking a region on one bad lookup would be a
// worse failure than the one this guards against.

var (
	probeEgressMatch = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_probe_egress_match",
			Help: "1 when this probe's egress IP geolocates to its declared region's continent, 0 on a confirmed mismatch, -1 when the lookup was inconclusive.",
		},
		[]string{"region"},
	)

	// Info-style series: the value is always 1, the labels carry the reading.
	// Deliberately low cardinality per probe (one series per region, replaced
	// when the address changes) so it can be read straight off a dashboard
	// when a region looks wrong.
	probeEgressInfo = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_probe_egress_info",
			Help: "Always 1. Labels carry where this probe's egress IP says it is.",
		},
		[]string{"region", "continent", "country", "city", "ip"},
	)

	probeEgressSuppressed = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_probe_egress_suppressed",
			Help: "1 while this probe is withholding latency samples because its egress is on the wrong continent.",
		},
		[]string{"region"},
	)

	// Its own counter rather than a result value on rpc_call_total: that one is
	// the providers' reliability record and feeds the published success rate,
	// so our own misrouting must not land in it.
	probeEgressDropped = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_probe_egress_dropped_total",
			Help: "Successful probe responses discarded because this probe's egress was on the wrong continent.",
		},
		[]string{"region"},
	)
)

// The continent each probe region must egress from. Continent rather than
// country on purpose: the failure worth suppressing is "Singapore served from
// North America", a whole ocean. A Singapore probe egressing from Tokyo is
// mildly wrong and still far more useful than no data, and pinning a country
// would also false-positive the day Railway moves eu-west from Amsterdam to
// Frankfurt.
var regionContinent = map[string]string{
	"us-east": "NA",
	"eu-west": "EU",
	"sgp":     "AS",
}

func expectedContinent() string {
	if v := strings.ToUpper(strings.TrimSpace(os.Getenv("RPC_KEYED_EXPECT_CONTINENT"))); v != "" {
		return v
	}
	return regionContinent[currentRegion]
}

func egressEnforced() bool {
	// Enforcement on by default: a detector that only watches still leaves the
	// wrong number published under the right label, which is the whole defect.
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RPC_KEYED_EGRESS_ENFORCE"))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

func egressInterval() time.Duration {
	if v := strings.TrimSpace(os.Getenv("RPC_KEYED_EGRESS_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 60 {
			return time.Duration(n) * time.Second
		}
	}
	return 10 * time.Minute
}

// Suppression needs this many consecutive confirmed mismatches. Two at a ten
// minute cadence means a region goes dark twenty minutes after a real move,
// and never on a single odd reading.
const egressStrikesToSuppress = 2

type egressGuard struct {
	mu         sync.RWMutex
	suppressed bool
	strikes    int
	lastIP     string
}

var egress = &egressGuard{}

// egressPublishable reports whether latency samples may be recorded. It starts
// true and only ever goes false after confirmation, so a probe that cannot
// reach a geolocation service keeps measuring.
func egressPublishable() bool {
	egress.mu.RLock()
	defer egress.mu.RUnlock()
	return !egress.suppressed
}

type egressReading struct {
	ip        string
	country   string
	continent string
	city      string
}

// Its own client and transport: the probe's pools are the thing under
// measurement and must not carry unrelated traffic.
var egressHTTP = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		DialContext:       (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		DisableKeepAlives: true,
	},
}

func lookupIPAPI(ctx context.Context) (egressReading, error) {
	var out egressReading
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://ip-api.com/json/?fields=status,continentCode,countryCode,city,query", nil)
	if err != nil {
		return out, err
	}
	resp, err := egressHTTP.Do(req)
	if err != nil {
		return out, err
	}
	defer func() { _ = resp.Body.Close() }()
	var body struct {
		Status        string `json:"status"`
		ContinentCode string `json:"continentCode"`
		CountryCode   string `json:"countryCode"`
		City          string `json:"city"`
		Query         string `json:"query"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return out, err
	}
	if body.Status != "success" || body.CountryCode == "" {
		return out, fmt.Errorf("ip-api status %q", body.Status)
	}
	return egressReading{
		ip:        body.Query,
		country:   strings.ToUpper(body.CountryCode),
		continent: strings.ToUpper(body.ContinentCode),
		city:      body.City,
	}, nil
}

// Second opinion. Only its country is used, to corroborate the first source;
// the continent always comes from ip-api so there is no country-to-continent
// table to keep correct.
func lookupIPInfo(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://ipinfo.io/json", nil)
	if err != nil {
		return "", err
	}
	resp, err := egressHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	var body struct {
		Country string `json:"country"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.Country == "" {
		return "", fmt.Errorf("ipinfo returned no country")
	}
	return strings.ToUpper(body.Country), nil
}

// checkEgress runs one round and updates the metrics and the guard.
func checkEgress(ctx context.Context) {
	want := expectedContinent()
	if want == "" {
		// An unmapped region cannot be judged, and guessing would suppress a
		// region for having an unfamiliar name.
		probeEgressMatch.WithLabelValues(currentRegion).Set(-1)
		return
	}

	primary, err := lookupIPAPI(ctx)
	if err != nil {
		fmt.Printf("[egress] lookup failed, keeping previous verdict: %v\n", err)
		probeEgressMatch.WithLabelValues(currentRegion).Set(-1)
		return
	}
	second, err := lookupIPInfo(ctx)
	if err != nil {
		fmt.Printf("[egress] second opinion unavailable, not acting: %v\n", err)
		probeEgressMatch.WithLabelValues(currentRegion).Set(-1)
		return
	}
	if second != primary.country {
		fmt.Printf("[egress] sources disagree (%s vs %s), not acting\n", primary.country, second)
		probeEgressMatch.WithLabelValues(currentRegion).Set(-1)
		return
	}

	egress.mu.Lock()
	if primary.ip != egress.lastIP {
		// One series per address: the old labels would otherwise sit at 1
		// forever and a dashboard would show two places at once.
		probeEgressInfo.Reset()
		egress.lastIP = primary.ip
	}
	egress.mu.Unlock()
	probeEgressInfo.WithLabelValues(currentRegion, primary.continent, primary.country,
		primary.city, primary.ip).Set(1)

	if primary.continent == want {
		egress.mu.Lock()
		was := egress.suppressed
		egress.strikes = 0
		egress.suppressed = false
		egress.mu.Unlock()
		probeEgressMatch.WithLabelValues(currentRegion).Set(1)
		probeEgressSuppressed.WithLabelValues(currentRegion).Set(0)
		if was {
			fmt.Printf("[egress] back on %s (%s, %s via %s), publishing again\n",
				want, primary.city, primary.country, primary.ip)
		}
		return
	}

	egress.mu.Lock()
	egress.strikes++
	strikes := egress.strikes
	if egressEnforced() && strikes >= egressStrikesToSuppress {
		egress.suppressed = true
	}
	suppressed := egress.suppressed
	egress.mu.Unlock()

	probeEgressMatch.WithLabelValues(currentRegion).Set(0)
	if suppressed {
		probeEgressSuppressed.WithLabelValues(currentRegion).Set(1)
	}
	fmt.Printf("[egress] MISMATCH region=%s expected=%s got=%s (%s, %s via %s) strike=%d suppressed=%v\n",
		currentRegion, want, primary.continent, primary.city, primary.country,
		primary.ip, strikes, suppressed)
}

// StartEgressWatch checks immediately, then on a ticker. The first check runs
// in the background rather than blocking startup: the probe loop may publish a
// cycle or two before the first verdict, which is the right trade against a
// probe that will not start because a geolocation service is slow.
func StartEgressWatch(ctx context.Context) {
	go func() {
		checkEgress(ctx)
		t := time.NewTicker(egressInterval())
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				checkEgress(ctx)
			}
		}
	}()
}
