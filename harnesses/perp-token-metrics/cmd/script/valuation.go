package main

// valuation is the computed row for one protocol. Has* flags say which
// ratios are defined; the caller deletes the gauge when a flag is false
// instead of publishing zero, so "no token" and "no data" never read as
// "worth nothing".
type valuation struct {
	Fees24h, Fees30d, FeesPrev30d, Fees1y, AnnualFees float64
	Rev24h, Rev30d, AnnualRev, RevSharePct            float64
	HasRev                                            bool

	HasToken            bool
	Mcap, FDV, FloatPct float64

	PF, PFfdv, PS, PE             float64
	HasPF, HasPFfdv, HasPS, HasPE bool
}

// annualize turns a trailing-30-day sum into a yearly run rate. Zero days
// inside the window count: a live adapter that recorded nothing is a
// real observation, and the same cut is applied to every protocol.
func annualize(sum30d float64) float64 {
	return sum30d * 365 / 30
}

// computeValuation derives every ratio from one fees series, an optional
// revenue series, and the CoinGecko market row. hasToken=false (no listing)
// publishes fees only.
//
//	P/F     = market cap / annualized fees        (defillama.com/pf convention)
//	FDV/F   = fully diluted valuation / annualized fees
//	P/S     = market cap / annualized revenue     (revenue = protocol + holders share)
//	P/E     = FDV / annualized revenue            (bench 234, unchanged definition)
func computeValuation(fees, rev llamaSeries, hasRev bool, m cgMarket, hasToken bool) valuation {
	v := valuation{
		Fees24h:     fees.Total24h,
		Fees30d:     fees.Sum30d,
		FeesPrev30d: fees.SumPrev30,
		Fees1y:      fees.Sum1y,
		AnnualFees:  annualize(fees.Sum30d),
		HasRev:      hasRev,
		HasToken:    hasToken,
	}
	if hasRev {
		v.Rev24h = rev.Total24h
		v.Rev30d = rev.Sum30d
		v.AnnualRev = annualize(rev.Sum30d)
		if v.Fees30d > 0 {
			v.RevSharePct = 100 * v.Rev30d / v.Fees30d
		}
	}
	if !hasToken {
		return v
	}
	v.Mcap = m.Mcap
	v.FDV = m.FDV
	if m.TotalSupply > 0 && m.Circ > 0 {
		v.FloatPct = 100 * m.Circ / m.TotalSupply
	}
	if v.AnnualFees > 0 {
		if v.Mcap > 0 {
			v.PF, v.HasPF = v.Mcap/v.AnnualFees, true
		}
		if v.FDV > 0 {
			v.PFfdv, v.HasPFfdv = v.FDV/v.AnnualFees, true
		}
	}
	if hasRev && v.AnnualRev > 0 {
		if v.Mcap > 0 {
			v.PS, v.HasPS = v.Mcap/v.AnnualRev, true
		}
		if v.FDV > 0 {
			v.PE, v.HasPE = v.FDV/v.AnnualRev, true
		}
	}
	return v
}
