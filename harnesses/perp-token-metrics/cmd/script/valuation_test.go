package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func approx(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6*math.Max(1, math.Abs(want)) {
		t.Fatalf("%s: got %v want %v", name, got, want)
	}
}

// chart builds a DeFiLlama-style totalDataChart of n daily points, latest
// last, where day i (0 = oldest) is worth f(i).
func chart(n int, f func(i int) float64) [][2]json.Number {
	out := make([][2]json.Number, 0, n)
	for i := 0; i < n; i++ {
		t := int64(1_700_000_000 + i*86400)
		out = append(out, [2]json.Number{json.Number(fmt.Sprint(t)), json.Number(fmt.Sprintf("%.2f", f(i)))})
	}
	return out
}

func TestWindowsFromChart_Cuts30_60_365(t *testing.T) {
	// 400 days of $1/day, except the most recent 30 days at $2/day.
	c := chart(400, func(i int) float64 {
		if i >= 370 {
			return 2
		}
		return 1
	})
	s := windowsFromChart(2, c)
	approx(t, "Sum30d", s.Sum30d, 60)
	approx(t, "SumPrev30", s.SumPrev30, 30)
	approx(t, "Sum1y", s.Sum1y, 60+335)
	approx(t, "Avg30d", s.Avg30d, 2)
	if s.Days30 != 30 {
		t.Fatalf("Days30: got %d want 30", s.Days30)
	}
}

func TestWindowsFromChart_UnsortedAndShort(t *testing.T) {
	c := chart(10, func(i int) float64 { return float64(i + 1) }) // 1..10
	// Shuffle: move the latest point to the front.
	c = append(c[9:], c[:9]...)
	s := windowsFromChart(10, c)
	approx(t, "Sum30d", s.Sum30d, 55)
	approx(t, "SumPrev30", s.SumPrev30, 0)
	approx(t, "Sum1y", s.Sum1y, 55)
}

func TestWindowsFromChart_ZeroDaysCountInSumNotAvg(t *testing.T) {
	c := chart(30, func(i int) float64 {
		if i%2 == 0 {
			return 0
		}
		return 10
	})
	s := windowsFromChart(0, c)
	approx(t, "Sum30d", s.Sum30d, 150)
	if s.Days30 != 15 {
		t.Fatalf("Days30: got %d want 15", s.Days30)
	}
	approx(t, "Avg30d", s.Avg30d, 10)
	// Annualization is on the sum, so the zero days lower the run rate.
	approx(t, "annualize", annualize(s.Sum30d), 150*365/30)
}

func TestComputeValuation_AllRatios(t *testing.T) {
	fees := llamaSeries{Total24h: 20_000, Sum30d: 600_000}
	rev := llamaSeries{Total24h: 15_000, Sum30d: 450_000}
	m := cgMarket{Mcap: 10_000_000, FDV: 12_000_000, Circ: 25, TotalSupply: 30}
	v := computeValuation(fees, rev, true, m, true)

	annualFees := 600_000.0 * 365 / 30
	annualRev := 450_000.0 * 365 / 30
	approx(t, "AnnualFees", v.AnnualFees, annualFees)
	approx(t, "AnnualRev", v.AnnualRev, annualRev)
	approx(t, "RevSharePct", v.RevSharePct, 75)
	approx(t, "FloatPct", v.FloatPct, 100*25.0/30)
	approx(t, "PF", v.PF, 10_000_000/annualFees)
	approx(t, "PFfdv", v.PFfdv, 12_000_000/annualFees)
	approx(t, "PS", v.PS, 10_000_000/annualRev)
	approx(t, "PE", v.PE, 12_000_000/annualRev)
	for name, ok := range map[string]bool{"HasPF": v.HasPF, "HasPFfdv": v.HasPFfdv, "HasPS": v.HasPS, "HasPE": v.HasPE, "HasRev": v.HasRev} {
		if !ok {
			t.Fatalf("%s should be true", name)
		}
	}
}

func TestComputeValuation_TokenlessPublishesFeesOnly(t *testing.T) {
	fees := llamaSeries{Total24h: 1, Sum30d: 30}
	v := computeValuation(fees, llamaSeries{}, false, cgMarket{}, false)
	approx(t, "Fees30d", v.Fees30d, 30)
	if v.HasPF || v.HasPFfdv || v.HasPS || v.HasPE || v.HasRev {
		t.Fatalf("no ratio may be defined without a token: %+v", v)
	}
	if v.Mcap != 0 || v.FDV != 0 || v.FloatPct != 0 {
		t.Fatalf("market fields must stay zero without a token: %+v", v)
	}
}

func TestComputeValuation_ZeroFeesDefinesNoRatio(t *testing.T) {
	v := computeValuation(llamaSeries{}, llamaSeries{}, true, cgMarket{Mcap: 1, FDV: 1}, true)
	if v.HasPF || v.HasPFfdv || v.HasPS || v.HasPE {
		t.Fatalf("ratios must be undefined when the denominator is zero: %+v", v)
	}
	if v.RevSharePct != 0 {
		t.Fatalf("rev share undefined on zero fees, got %v", v.RevSharePct)
	}
}

func TestComputeValuation_NoRevenueKeepsFeeRatios(t *testing.T) {
	fees := llamaSeries{Sum30d: 300}
	v := computeValuation(fees, llamaSeries{}, false, cgMarket{Mcap: 3650, FDV: 7300}, true)
	approx(t, "PF", v.PF, 1)
	approx(t, "PFfdv", v.PFfdv, 2)
	if v.HasPS || v.HasPE {
		t.Fatalf("P/S and P/E need revenue: %+v", v)
	}
}

// fakeUpstream serves the three upstream shapes the harness reads.
func fakeUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/summary/fees/", func(w http.ResponseWriter, r *http.Request) {
		slug := strings.TrimPrefix(r.URL.Path, "/summary/fees/")
		dt := r.URL.Query().Get("dataType")
		per := map[string]float64{"dailyFees": 100, "dailyRevenue": 40}[dt]
		if slug == "broken" {
			http.Error(w, "Not found", 404)
			return
		}
		if slug == "empty" {
			_ = json.NewEncoder(w).Encode(map[string]any{"total24h": 0, "totalDataChart": [][2]any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"total24h":       per,
			"totalDataChart": chart(90, func(int) float64 { return per }),
		})
	})
	mux.HandleFunc("/coins/markets", func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "ids=") {
			http.Error(w, "missing ids", 400)
			return
		}
		fmt.Fprint(w, `[
		  {"id":"tok","market_cap":1000000,"fully_diluted_valuation":2000000,"circulating_supply":50,"total_supply":100},
		  {"id":"nofdv","market_cap":500000,"fully_diluted_valuation":null,"circulating_supply":null,"total_supply":null}
		]`)
	})
	mux.HandleFunc("/overview/open-interest", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"protocols":[{"slug":"tok-perps","total24h":250000},{"slug":"dead","total24h":null}]}`)
	})
	return httptest.NewServer(mux)
}

func TestFetchers_AgainstFakeUpstream(t *testing.T) {
	srv := fakeUpstream(t)
	defer srv.Close()
	oldL, oldC := llamaBase, cgBase
	llamaBase, cgBase = srv.URL, srv.URL
	defer func() { llamaBase, cgBase = oldL, oldC }()

	fees, ok := fetchLlamaSeries("tok", "dailyFees")
	if !ok {
		t.Fatal("fees fetch should succeed")
	}
	approx(t, "fees.Sum30d", fees.Sum30d, 3000)
	approx(t, "fees.SumPrev30", fees.SumPrev30, 3000)
	approx(t, "fees.Sum1y", fees.Sum1y, 9000)

	if _, ok := fetchLlamaSeries("broken", "dailyFees"); ok {
		t.Fatal("404 must report !ok")
	}
	if _, ok := fetchLlamaSeries("empty", "dailyFees"); ok {
		t.Fatal("empty chart must report !ok")
	}

	m := fetchCGMarkets([]string{"tok", "nofdv", "missing"})
	if len(m) != 2 {
		t.Fatalf("expected 2 market rows, got %d", len(m))
	}
	approx(t, "tok.FDV", m["tok"].FDV, 2_000_000)
	approx(t, "nofdv.FDV falls back to mcap", m["nofdv"].FDV, 500_000)
	if _, present := m["missing"]; present {
		t.Fatal("unknown id must be absent")
	}
	if fetchCGMarkets(nil) == nil {
		t.Fatal("empty id list must return an empty map, not nil")
	}

	oi := fetchLlamaOpenInterest()
	approx(t, "oi tok-perps", oi["tok-perps"], 250_000)
	if _, present := oi["dead"]; present {
		t.Fatal("null OI must be absent")
	}
}

func TestProtocolTable_NoDuplicateSlugsOrIDs(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range protocols {
		for _, k := range []string{"slug:" + p.slug, "cg:" + p.cgID} {
			if strings.HasSuffix(k, ":") {
				continue
			}
			if seen[k] {
				t.Fatalf("duplicate %s", k)
			}
			seen[k] = true
		}
		if p.llamaSlug == "" {
			t.Fatalf("%s: llamaSlug required", p.slug)
		}
	}
}
