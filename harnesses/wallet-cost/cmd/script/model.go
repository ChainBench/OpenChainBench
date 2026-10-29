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

// coefficient returns how many units of a meter one monthly active user
// produces under a profile.
func coefficient(m Meter, pr Profile) float64 {
	return m.PerUser + m.PerTx*pr.TxPerUser + m.PerNewWallet*pr.NewUserShare
}

func quantity(m Meter, pr Profile, mau float64) float64 {
	return coefficient(m, pr) * mau
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

func pricePlan(p Provider, pl Plan, pr Profile, mau float64) planResult {
	if pl.MonthlyUSD == nil {
		return planResult{reason: fmt.Sprintf("%s has no published price", pl.Name), quote: true}
	}
	for _, meter := range sortedKeys(pl.Caps) {
		if q := quantity(p.Meters[meter], pr, mau); over(q, pl.Caps[meter]) {
			return planResult{reason: fmt.Sprintf("%s stops at %s %s", pl.Name, fmtCount(pl.Caps[meter]), meterNoun(meter))}
		}
	}
	for _, meter := range sortedKeys(pl.QuoteAbove) {
		if q := quantity(p.Meters[meter], pr, mau); over(q, pl.QuoteAbove[meter]) {
			return planResult{
				reason: fmt.Sprintf("above %s %s on %s the price is on request", fmtCount(pl.QuoteAbove[meter]), meterNoun(meter), pl.Name),
				quote:  true,
			}
		}
	}
	charges := 0.0
	for _, meter := range sortedKeys(pl.Tiers) {
		charges += graduated(quantity(p.Meters[meter], pr, mau), pl.Tiers[meter])
	}
	fee := *pl.MonthlyUSD
	bill := fee + charges
	if pl.Minimum {
		bill = math.Max(fee, charges)
	}
	conf := pl.Confidence
	for meter, v := range pl.UncertainAbove {
		if over(quantity(p.Meters[meter], pr, mau), v) {
			conf = "uncertain"
		}
	}
	return planResult{ok: true, bill: bill, confidence: conf}
}

// cheapest returns the provider's lowest bill for a profile at a MAU count.
// Ties go to the plan listed first, which the catalogue orders by fee, so
// the answer is reproducible.
func cheapest(p Provider, pr Profile, mau float64) Quote {
	if why, ok := p.ProfileExclusions[pr.ID]; ok {
		return Quote{Reason: why}
	}
	best := Quote{}
	var reasons []planResult
	for _, pl := range p.Plans {
		r := pricePlan(p, pl, pr, mau)
		if !r.ok {
			reasons = append(reasons, r)
			continue
		}
		if !best.Eligible || r.bill < best.MonthlyUSD-1e-9 {
			best = Quote{Eligible: true, Plan: pl.ID, PlanName: pl.Name, MonthlyUSD: r.bill, Confidence: r.confidence}
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
	case "mau":
		return "monthly active users"
	case "signatures":
		return "signatures a month"
	case "operations":
		return "operations a month"
	case "credits":
		return "credits a month"
	case "transactions":
		return "transactions a month"
	case "wallets":
		return "wallets"
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
