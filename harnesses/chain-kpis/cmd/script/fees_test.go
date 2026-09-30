package main

import (
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func fw(d24, d7, d30 float64) feeWindows {
	return feeWindows{Total24h: &d24, Total7d: &d7, Total30d: &d30}
}

func near(a, b float64) bool { return math.Abs(a-b) <= 1e-9*math.Max(1, math.Abs(b)) }

// A chain with $30M of fees over 30 days and a $3.65B token trades at
// P/F 10: 3.65e9 / (30e6 * 365 / 30) = 3.65e9 / 365e6.
func TestRatiosUseThirtyDayRunRate(t *testing.T) {
	o := computeChainFees(fw(1e6, 7e6, 30e6), fw(0.5e6, 3.5e6, 15e6), true, 3.65e9, true)
	if o.pf == nil || !near(*o.pf, 10) {
		t.Fatalf("pf = %v, want 10", deref(o.pf))
	}
	if o.ps == nil || !near(*o.ps, 20) {
		t.Fatalf("ps = %v, want 20", deref(o.ps))
	}
	if o.revShare == nil || !near(*o.revShare, 50) {
		t.Fatalf("revShare = %v, want 50", deref(o.revShare))
	}
	if o.fees24h == nil || *o.fees24h != 1e6 || o.rev7d == nil || *o.rev7d != 3.5e6 {
		t.Fatalf("windows not carried: %+v", o)
	}
}

// No fees over the month: nothing publishes. A $0 row that looks measured
// (Taiko, Mode on 2026-09-25) is worse than no row.
func TestNoFeesOverTheMonthPublishesNothing(t *testing.T) {
	o := computeChainFees(fw(0, 0, 0), fw(0, 0, 0), true, 1e9, true)
	if o.fees30d != nil || o.fees24h != nil || o.rev30d != nil || o.pf != nil || o.ps != nil || o.revShare != nil {
		t.Fatalf("expected an empty publish, got %+v", o)
	}
}

// A quiet day inside an active month is a real zero and publishes as one.
func TestQuietDayInsideActiveMonthPublishesZero(t *testing.T) {
	o := computeChainFees(fw(0, 2e6, 9e6), fw(0, 1e6, 4e6), true, 0, false)
	if o.fees24h == nil || *o.fees24h != 0 {
		t.Fatalf("fees24h = %v, want 0", deref(o.fees24h))
	}
	if o.pf != nil || o.ps != nil {
		t.Fatalf("no market cap, no ratio: %+v", o)
	}
}

// Revenue that DefiLlama does not report leaves the revenue side and the
// ratios that need it unpublished, while fees still publish.
func TestMissingRevenueKeepsFeesOnly(t *testing.T) {
	o := computeChainFees(fw(1e6, 7e6, 30e6), feeWindows{}, false, 1e9, true)
	if o.fees30d == nil || o.rev30d != nil || o.revShare != nil || o.ps != nil {
		t.Fatalf("unexpected revenue side: %+v", o)
	}
	if o.pf == nil {
		t.Fatalf("P/F needs fees only and should publish")
	}
	zero := 0.0
	o = computeChainFees(fw(1e6, 7e6, 30e6), feeWindows{Total24h: &zero, Total7d: &zero, Total30d: &zero}, true, 1e9, true)
	if o.ps != nil {
		t.Fatalf("zero revenue is not a division: %+v", o)
	}
	if o.revShare == nil || *o.revShare != 0 {
		t.Fatalf("zero revenue over positive fees is a 0%% share: %+v", o)
	}
}

// A timeout on the revenue request alone must not blank the Revenue,
// Kept and P/S columns for an hour: the fee side updates and the revenue
// side keeps last hour's values. A definitive empty answer clears it.
func TestRevenueTransportErrorKeepsLastRevenue(t *testing.T) {
	const slug = "test-rev-carry"
	full := computeChainFees(fw(1e6, 7e6, 30e6), fw(0.5e6, 3.5e6, 15e6), true, 3.65e9, true)
	publishChainFees(slug, full, true)
	if v := gaugeValue(chainRevenue30dUsd, slug); v != 15e6 {
		t.Fatalf("revenue30d = %v, want 15e6", v)
	}

	feesOnly := computeChainFees(fw(2e6, 8e6, 31e6), feeWindows{}, false, 3.65e9, true)
	publishChainFees(slug, feesOnly, false)
	if v := gaugeValue(chainFees30dUsd, slug); v != 31e6 {
		t.Fatalf("fees30d = %v, want the fresh 31e6", v)
	}
	if v := gaugeValue(chainRevenue30dUsd, slug); v != 15e6 {
		t.Fatalf("revenue30d = %v, want last hour's 15e6 kept", v)
	}
	if v := gaugeValue(chainTokenPsRatio, slug); !near(v, 20) {
		t.Fatalf("ps = %v, want last hour's 20 kept", v)
	}

	publishChainFees(slug, feesOnly, true)
	for _, g := range []struct {
		name string
		n    int
	}{
		{"revenue30d", seriesCount(chainRevenue30dUsd)},
		{"share", seriesCount(chainRevenueSharePct)},
		{"ps", seriesCount(chainTokenPsRatio)},
	} {
		if g.n != 0 {
			t.Fatalf("%s: %d series left after a definitive empty revenue answer", g.name, g.n)
		}
	}
	publishChainFees(slug, chainFeesOut{}, true)
}

// A failed CoinGecko or /v2/chains call reuses last tick's answer instead
// of deleting every ratio; before any success it yields an empty map, and
// a later success replaces the kept one.
func TestSecondaryInputFailureKeepsLastAnswer(t *testing.T) {
	var last map[string]tokenMcap
	boom := errors.New("http_500")
	if got := keepLast[string, tokenMcap](nil, boom, &last); len(got) != 0 {
		t.Fatalf("nothing to fall back on should be empty, got %v", got)
	}
	first := map[string]tokenMcap{"ethereum": {Mcap: 3e11}}
	if got := keepLast(first, nil, &last); got["ethereum"].Mcap != 3e11 {
		t.Fatalf("fresh answer not returned: %v", got)
	}
	if got := keepLast[string, tokenMcap](nil, boom, &last); got["ethereum"].Mcap != 3e11 {
		t.Fatalf("failure should reuse the kept answer, got %v", got)
	}
	second := map[string]tokenMcap{"ethereum": {Mcap: 3.1e11}}
	keepLast(second, nil, &last)
	if got := keepLast[string, tokenMcap](nil, boom, &last); got["ethereum"].Mcap != 3.1e11 {
		t.Fatalf("a later success should replace the kept answer, got %v", got)
	}
}

// gaugeValue reads a series that is known to exist (WithLabelValues would
// otherwise create it).
func gaugeValue(g *prometheus.GaugeVec, slug string) float64 {
	var m dto.Metric
	if err := g.WithLabelValues(slug).Write(&m); err != nil {
		panic(err)
	}
	return m.GetGauge().GetValue()
}

func seriesCount(g *prometheus.GaugeVec) int {
	ch := make(chan prometheus.Metric, 256)
	g.Collect(ch)
	close(ch)
	n := 0
	for range ch {
		n++
	}
	return n
}

func deref(p *float64) float64 {
	if p == nil {
		return math.NaN()
	}
	return *p
}

// DefiLlama's chain aggregate for Tron leaves out Tron's own gas adapter:
// the chain total read $8.2M on 2026-09-26 while the adapters it lists for
// the chain summed to $32.3M, the gas line alone being $24.2M. Published
// as is, that put TRX on the board at 334x price to fees instead of about
// 85x. The fee figure still publishes; the ratios built on it do not.
func TestChainTotalShortOfItsAdaptersWithholdsTheRatios(t *testing.T) {
	adapters := func(vals ...float64) []struct {
		Name     string   `json:"name"`
		Total30d *float64 `json:"total30d"`
	} {
		out := make([]struct {
			Name     string   `json:"name"`
			Total30d *float64 `json:"total30d"`
		}, 0, len(vals))
		for i, v := range vals {
			v := v
			out = append(out, struct {
				Name     string   `json:"name"`
				Total30d *float64 `json:"total30d"`
			}{Name: fmt.Sprintf("a%d", i), Total30d: &v})
		}
		return out
	}

	tron := feeWindows{Total30d: f64(8_164_514), Protocols: adapters(24_160_000, 4_180_000, 1_630_000, 860_000, 570_000, 300_000, 270_000, 150_000)}
	out := computeChainFees(tron, feeWindows{Total30d: f64(1_392_117)}, true, 33_161_709_305, true)
	if !out.feesIncomplete {
		t.Fatal("a chain total four times under its own adapters is incomplete")
	}
	if out.coverage < 3.9 || out.coverage > 4.0 {
		t.Fatalf("coverage %v, want about 3.96", out.coverage)
	}
	if out.pf != nil || out.ps != nil {
		t.Fatalf("no ratio on a denominator the source contradicts, got pf=%v ps=%v", out.pf, out.ps)
	}
	if out.fees30d == nil || *out.fees30d != 8_164_514 {
		t.Fatal("the fee figure itself still publishes")
	}

	// Ethereum on the same day: the usual few points of overlap between a
	// parent and its products, which is not a missing line.
	eth := feeWindows{Total30d: f64(331_000_000), Protocols: adapters(200_000_000, 100_000_000, 53_200_000)}
	out = computeChainFees(eth, feeWindows{Total30d: f64(59_500_000)}, true, 328_700_000_000, true)
	if out.feesIncomplete {
		t.Fatalf("1.07x coverage is normal overlap, got %v", out.coverage)
	}
	if out.pf == nil {
		t.Fatal("a sound total keeps its ratio")
	}

	// No breakdown in the response: nothing to check against, so nothing
	// is claimed and the ratios stand.
	bare := feeWindows{Total30d: f64(1_000_000)}
	out = computeChainFees(bare, feeWindows{}, false, 1e9, true)
	if out.feesIncomplete || out.pf == nil {
		t.Fatal("without a breakdown the total is taken as given")
	}
}
