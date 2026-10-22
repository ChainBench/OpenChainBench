package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// What #3192 established, pinned so it cannot quietly come back.
//
// The settle histogram's mean was 50x its median (Robinhood: 0.37 s median,
// 19.8 s mean) because about 4 % of pairs stall past 60 s. The published figure
// must therefore be a quantile of the non-stalled pairs, and a stall must be
// counted apart.

// metricValue reads one gauge or counter child without the testutil package.
func metricValue(m prometheus.Metric) float64 {
	var d dto.Metric
	if err := m.Write(&d); err != nil {
		return -1
	}
	if d.Gauge != nil {
		return d.Gauge.GetValue()
	}
	if d.Counter != nil {
		return d.Counter.GetValue()
	}
	return -1
}

func resetSettleState() {
	pumpDepWindow.Lock()
	pumpDepWindow.seen = nil
	pumpDepWindow.Unlock()
	pumpSettleWindow.Lock()
	pumpSettleWindow.by = nil
	pumpSettleWindow.Unlock()
	pumpBlockTime.Lock()
	pumpBlockTime.at = nil
	pumpBlockTime.Unlock()
	// The gauge keeps a child once set, so a second run in the same process
	// (-count=2) would see the first run's median and the floor test would
	// read a series that this run never published.
	gSettleMs.Reset()
}

// The published settlement figure is the median, not the mean.
//
// 96 pairs at 1 s and 4 at 59 s (still under the stall cut, so they are in the
// window): mean 3.32 s, median 1 s. A gauge that reads 3320 ms has gone back to
// sum/count.
func TestPublishedSettleIsTheMedianNotTheMean(t *testing.T) {
	resetSettleState()
	t.Cleanup(resetSettleState)
	const chain = "test-median"
	for i := 0; i < 96; i++ {
		pumpNoteSettle(chain, 1)
	}
	for i := 0; i < 4; i++ {
		pumpNoteSettle(chain, 59)
	}
	if !settlePublished(chain) {
		t.Fatal("no median published for 100 pairs")
	}
	got := metricValue(gSettleMs.WithLabelValues("pump-bridge", chain, "median"))
	if got != 1000 {
		t.Fatalf("published median %v ms, want 1000 (the mean of this sample is 3320 ms)", got)
	}
}

// settlePublished reports whether a median series exists for this chain,
// without creating one (WithLabelValues would).
func settlePublished(chain string) bool {
	ch := make(chan prometheus.Metric, 256)
	go func() { gSettleMs.Collect(ch); close(ch) }()
	found := false
	for m := range ch {
		var d dto.Metric
		if m.Write(&d) != nil {
			continue
		}
		var c, st string
		for _, l := range d.Label {
			switch l.GetName() {
			case "chain":
				c = l.GetValue()
			case "stat":
				st = l.GetValue()
			}
		}
		if c == chain && st == "median" {
			found = true
		}
	}
	return found
}

// Below pumpSettleMin pairs nothing is published (#3197): after a restart the
// first pair of the process used to be published as the route's median.
func TestNoQuantileBelowTheSampleFloor(t *testing.T) {
	resetSettleState()
	t.Cleanup(resetSettleState)
	const chain = "test-floor"
	for i := 0; i < pumpSettleMin-1; i++ {
		pumpNoteSettle(chain, 1)
	}
	if settlePublished(chain) {
		t.Fatalf("a median was published from %d pairs, under the floor of %d", pumpSettleMin-1, pumpSettleMin)
	}
	pumpNoteSettle(chain, 1)
	if !settlePublished(chain) {
		t.Fatalf("no median at exactly %d pairs: the floor is off by one", pumpSettleMin)
	}
}

// A stall past 60 s never reaches the published quantiles.
//
// Twenty stalls of 300 s on top of twenty 1 s pairs: if stalls entered the
// window, the median would be the 300 s value (nearest rank at index 20 of 40).
// Twenty, not ten, so the clean sample clears pumpSettleMin with room to spare
// and the assertion is never made against a series that was not published.
func TestStallsStayOutOfThePublishedQuantiles(t *testing.T) {
	resetSettleState()
	t.Cleanup(resetSettleState)
	const chain = "test-stall-window"
	for i := 0; i < 20; i++ {
		pumpNoteSettle(chain, 1)
		pumpNoteSettle(chain, 300)
	}
	if !settlePublished(chain) {
		t.Fatal("no quantile published for 20 clean pairs: the assertion below would test nothing")
	}
	for _, stat := range []string{"median", "p90"} {
		if got := metricValue(gSettleMs.WithLabelValues("pump-bridge", chain, stat)); got != 1000 {
			t.Errorf("%s = %v ms with stalls in the input, want 1000: stalls leaked into the published figure", stat, got)
		}
	}
}

// No published query may read the settle histogram as sum/count.
//
// The Help string says NEVER; this makes the spec obey it. Any of
// _sum, _count or avg over the settle series in a bench spec fails here.
func TestNoSpecReadsSettleAsAMean(t *testing.T) {
	specs, err := filepath.Glob(filepath.Join("..", "..", "..", "..", "benchmarks", "*.yml"))
	if err != nil || len(specs) == 0 {
		t.Fatalf("no bench specs found from the harness directory: %v", err)
	}
	bad := regexp.MustCompile(`tfq_pump_bridge_settle_seconds_(sum|count)|avg[a-z_]*\s*\(\s*tfq_(pump_bridge_settle_seconds|settle_ms)`)
	for _, p := range specs {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			if bad.MatchString(line) {
				t.Errorf("%s:%d reads settlement as a mean: %s", filepath.Base(p), i+1, strings.TrimSpace(line))
			}
		}
	}
}

// fakeBlockRPC answers eth_getBlockByNumber with a fixed timestamp.
func fakeBlockRPC(t *testing.T, ts int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Method != "eth_getBlockByNumber" {
			http.Error(w, "unexpected method "+req.Method, 400)
			return
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"result":{"timestamp":"0x%x"}}`, ts)
	}))
}

// pairOnce runs the real pairing path on one spend whose deposit is `lag`
// seconds older, and returns the stall counter's increase.
func pairOnce(t *testing.T, chain string, lag int64) float64 {
	t.Helper()
	resetSettleState()
	const depAt = int64(1_800_000_000)
	srv := fakeBlockRPC(t, depAt+lag)
	defer srv.Close()

	// A 10.000000 USDC deposit at 40 bps: the router spends 10 - 0.05 - 0.04.
	pumpNoteDeposit(depAt, 10.0)
	spent := big.NewInt(9_910_000)
	c := originChain{slug: chain, rpc: []string{srv.URL}}
	r := pumpRouter{chain: chain, decimals: 6}

	before := metricValue(cPumpStall.WithLabelValues(chain))
	unique := metricValue(cPumpPair.WithLabelValues(chain, "unique"))
	pumpPairSpend(context.Background(), srv.Client(), c, r, spent, 1)
	if metricValue(cPumpPair.WithLabelValues(chain, "unique"))-unique != 1 {
		t.Fatalf("lag %d s: the spend did not pair uniquely, the stall test would prove nothing", lag)
	}
	return metricValue(cPumpStall.WithLabelValues(chain)) - before
}

// The stall counter moves past 60 s and only past 60 s.
func TestStallCounterIncrementsPastSixtySeconds(t *testing.T) {
	t.Cleanup(resetSettleState)
	for _, tc := range []struct {
		lag  int64
		want float64
	}{{59, 0}, {60, 0}, {61, 1}, {275, 1}} {
		if got := pairOnce(t, fmt.Sprintf("test-stall-%d", tc.lag), tc.lag); got != tc.want {
			t.Errorf("lag %d s: stall counter rose by %v, want %v", tc.lag, got, tc.want)
		}
	}
}
