package main

import "sort"

// Row is one published protocol: the ratios, and the peer comparison that
// makes them mean something.
type Row struct {
	Protocol
	Mcap, FDV     float64
	FloatPct      float64
	HasFloat      bool
	AnnualFees    float64
	PF, PFfdv     float64
	HasPF, HasFDV bool

	FeeGrowthPct float64
	HasFeeGrowth bool
	PriceChgPct  float64
	HasPriceChg  bool

	// Peer comparison. A P/F of 1.05 is cheap against Yield (median 16.66)
	// and ordinary against Launchpad (median 1.05), so a single market-wide
	// median would rank the categories rather than the protocols.
	CategoryMedianPF float64
	HasPeerGroup     bool
}

// annualize turns a trailing-30-day sum into a yearly run rate, the same
// cut bench 234 and 265 use so the three boards stay comparable.
func annualize(sum30d float64) float64 { return sum30d * 365 / 30 }

// MinPeerGroup is how many tokens a category needs before its median is
// published. Below this the "median" is one or two protocols, and a row
// called cheap against it is cheap against an accident.
const MinPeerGroup = 5

// buildRows joins the cohort to the market data and computes every ratio.
// Pure, so the whole valuation is testable without a network.
func buildRows(cohort []Protocol, markets map[string]cgMarket, minFloatPct float64) []Row {
	rows := make([]Row, 0, len(cohort))
	for _, p := range cohort {
		m, ok := markets[p.GeckoID]
		if !ok || m.Mcap <= 0 {
			// No listing, or a token CoinGecko has no market cap for.
			// Publishing fees alone would put a row on a valuation board
			// with no valuation.
			continue
		}
		r := Row{Protocol: p, Mcap: m.Mcap, FDV: m.FDV, AnnualFees: annualize(p.Fees30d)}
		if m.Total > 0 && m.Circ > 0 {
			r.FloatPct, r.HasFloat = 100*m.Circ/m.Total, true
		}
		// A P/F on a 4 %-float token divides a market cap that barely
		// exists by real fees and prints a number near zero. That is not a
		// cheap protocol, it is an unlisted one, and it would take the top
		// of every ascending board.
		if r.HasFloat && r.FloatPct < minFloatPct {
			continue
		}
		if r.AnnualFees > 0 {
			r.PF, r.HasPF = r.Mcap/r.AnnualFees, true
			if m.FDV > 0 {
				r.PFfdv, r.HasFDV = m.FDV/r.AnnualFees, true
			}
		}
		if p.Prev30d > 0 {
			r.FeeGrowthPct, r.HasFeeGrowth = 100*(p.Fees30d/p.Prev30d-1), true
		}
		if m.PriceChg30d != nil {
			r.PriceChgPct, r.HasPriceChg = *m.PriceChg30d, true
		}
		rows = append(rows, r)
	}

	applyPeerMedians(rows)
	return rows
}

// applyPeerMedians stamps each row with its category's median P/F, and
// leaves the flag false for categories too small to have one.
func applyPeerMedians(rows []Row) {
	byCat := map[string][]float64{}
	for _, r := range rows {
		if r.HasPF {
			byCat[r.Category] = append(byCat[r.Category], r.PF)
		}
	}
	medians := map[string]float64{}
	for cat, vals := range byCat {
		if len(vals) < MinPeerGroup {
			continue
		}
		medians[cat] = median(vals)
	}
	for i := range rows {
		if m, ok := medians[rows[i].Category]; ok {
			rows[i].CategoryMedianPF, rows[i].HasPeerGroup = m, true
		}
	}
}

// CategoryMedians returns the published peer groups, for the gauge and for
// a reader who wants to check a row's comparison.
func CategoryMedians(rows []Row) map[string]float64 {
	byCat := map[string][]float64{}
	for _, r := range rows {
		if r.HasPF {
			byCat[r.Category] = append(byCat[r.Category], r.PF)
		}
	}
	out := map[string]float64{}
	for cat, vals := range byCat {
		if len(vals) >= MinPeerGroup {
			out[cat] = median(vals)
		}
	}
	return out
}

func median(vals []float64) float64 {
	s := append([]float64(nil), vals...)
	sort.Float64s(s)
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// Diverging is the screen the whole board exists for: fees up on the month,
// token down, and cheaper than its own peers.
//
// The third clause is what keeps it honest. Without it the screen is "fees
// up, price down", which names every protocol having a bad month; with it,
// the row also has to be cheap against the protocols it competes with.
func (r Row) Diverging() bool {
	return r.HasFeeGrowth && r.HasPriceChg && r.HasPF && r.HasPeerGroup &&
		r.FeeGrowthPct > 0 && r.PriceChgPct < 0 && r.PF < r.CategoryMedianPF
}
