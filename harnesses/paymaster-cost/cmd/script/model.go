package main

import (
	"fmt"
	"math"
	"strings"
)

// The bill model. Every quantity a vendor meters is linear in the number of
// monthly active users for a fixed profile, so for one plan the bill is a
// piecewise-linear function of MAU whose corners sit at tier boundaries,
// caps and quote thresholds. The curve emitter relies on that; see curve.go.

// epsilon absorbs float drift at an exact boundary. rpc-cost lost a provider
// entirely when profile shares summed to 1.0000000000000002 and pushed an
// exact-fit workload past a hard stop. A count of users never needs more
// precision than this.
const epsilon = 1e-9

// coefficient and offset describe a meter as an affine function of the
// scenario's axis x: units = offset + coefficient * x.
func coefficient(m Meter, s Scenario) float64 {
	return m.PerWallet*s.WalletsPerX + (m.PerTx+m.PerGasUSD*s.GasUSDPerTx)*s.TxPerX
}

func offset(m Meter, s Scenario) float64 {
	return m.PerWallet*s.WalletsFix + (m.PerTx+m.PerGasUSD*s.GasUSDPerTx)*s.TxFix
}

func quantity(m Meter, s Scenario, x float64) float64 {
	return offset(m, s) + coefficient(m, s)*x
}

// graduated prices q against a band list: each band bills its own slice.
func graduated(q float64, tiers []Tier) float64 {
	total, prev := 0.0, 0.0
	for _, t := range tiers {
		top := math.Inf(1)
		if t.UpTo != nil {
			top = *t.UpTo
		}
		if q > prev {
			total += *t.Rate * (math.Min(q, top) - prev)
		}
		if q <= top {
			break
		}
		prev = top
	}
	return total
}

// over reports q strictly above limit, tolerant of float drift.
func over(q, limit float64) bool {
	return q > limit*(1+epsilon)
}

type Quote struct {
	Eligible   bool
	Plan       string
	PlanName   string
	MonthlyUSD float64
	Confidence string
	// Bound is the plan's bound when Confidence is "uncertain".
	Bound string
	// Reason is set when not eligible, written for a reader.
	Reason string
}

type planResult struct {
	ok   bool
	bill float64
	// confidence of this reading: the plan's own, or "uncertain" when the
	// quantity crosses one of its uncertain_above thresholds.
	confidence string
	reason     string
	quote      bool // the reason is "no published price", not "cannot serve"
}

func pricePlan(p Provider, pl Plan, pr Scenario, x float64) planResult {
	if pl.MonthlyUSD == nil {
		return planResult{reason: fmt.Sprintf("%s has no published price", pl.Name), quote: true}
	}
	for _, meter := range sortedKeys(pl.Caps) {
		if q := quantity(p.Meters[meter], pr, x); over(q, pl.Caps[meter]) {
			return planResult{reason: fmt.Sprintf("%s stops at %s %s", pl.Name, fmtCount(pl.Caps[meter]), meterNoun(meter))}
		}
	}
	for _, meter := range sortedKeys(pl.QuoteAbove) {
		if q := quantity(p.Meters[meter], pr, x); over(q, pl.QuoteAbove[meter]) {
			return planResult{
				reason: fmt.Sprintf("above %s %s on %s the price is on request", fmtCount(pl.QuoteAbove[meter]), meterNoun(meter), pl.Name),
				quote:  true,
			}
		}
	}
	charges := 0.0
	for _, meter := range sortedKeys(pl.Tiers) {
		charges += graduated(quantity(p.Meters[meter], pr, x), pl.Tiers[meter])
	}
	fee := *pl.MonthlyUSD
	bill := fee + charges
	if pl.Minimum {
		bill = math.Max(fee, charges)
	}
	conf := pl.Confidence
	for meter, v := range pl.UncertainAbove {
		if over(quantity(p.Meters[meter], pr, x), v) {
			conf = "uncertain"
		}
	}
	return planResult{ok: true, bill: bill, confidence: conf}
}

// cheapest returns the provider's lowest bill for a profile at a MAU count.
// Ties go to the plan listed first, which the catalogue orders by fee, so
// the answer is reproducible.
func cheapest(p Provider, pr Scenario, x float64) Quote {
	if why, ok := p.ScenarioExclusions[pr.ID]; ok {
		return Quote{Reason: why}
	}
	best := Quote{}
	var reasons []planResult
	for _, pl := range p.Plans {
		r := pricePlan(p, pl, pr, x)
		if !r.ok {
			reasons = append(reasons, r)
			continue
		}
		if !best.Eligible || r.bill < best.MonthlyUSD-1e-9 {
			best = Quote{Eligible: true, Plan: pl.ID, PlanName: pl.Name, MonthlyUSD: r.bill, Confidence: r.confidence}
			if r.confidence == "uncertain" {
				best.Bound = pl.Bound
			}
		}
	}
	if best.Eligible {
		best.MonthlyUSD = roundCents(best.MonthlyUSD)
		return best
	}
	return Quote{Reason: explain(reasons)}
}

// explain picks the reason a reader needs: the largest self-serve plan's
// limit, then whether anything beyond it is sold at a price nobody published.
func explain(rs []planResult) string {
	var limit, quote string
	for _, r := range rs {
		if r.quote {
			quote = r.reason
		} else {
			limit = r.reason
		}
	}
	switch {
	case limit != "" && quote != "":
		return limit + "; " + lowerFirst(quote)
	case limit != "":
		return limit
	default:
		return quote
	}
}

func roundCents(v float64) float64 {
	return math.Round(v*100) / 100
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	// Plan names are proper nouns ("Enterprise has no published price"),
	// so only the generic phrasing is lowered.
	if strings.HasPrefix(s, "Above ") {
		return "above " + s[len("Above "):]
	}
	return s
}

func meterNoun(meter string) string {
	switch meter {
	case "wallets":
		return "wallets"
	case "active_wallets":
		return "active wallets a month"
	case "mau":
		return "monthly active users"
	case "signatures":
		return "signatures a month"
	case "operations":
		return "operations a month"
	case "credits":
		return "credits a month"
	case "requests":
		return "requests a month"
	case "thousand_requests":
		return "thousand requests a month"
	case "transactions":
		return "transactions a month"
	case "user_operations":
		return "user operations a month"
	case "sponsored_gas_usd", "gas_surcharge":
		return "USD of sponsored gas a month"
	case "hundred_thousand_credits":
		return "hundred thousand credits a month"
	case "quarter_million_credits":
		return "units of 250,000 credits a month"
	case "million_compute_units":
		return "million compute units a month"
	case "million_billing_units":
		return "million billing units a month"
	case "thousand_transactions":
		return "thousand transactions a month"
	}
	return meter
}

func fmtCount(v float64) string {
	n := int64(math.Round(v))
	s := fmt.Sprintf("%d", n)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}
