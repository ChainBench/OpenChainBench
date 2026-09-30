package main

import (
	"fmt"
	"math"
)

// The cost model. Given a provider, a workload profile and a monthly
// request count, what does the bill actually say.
//
// Every branch here exists because some provider in the cohort behaves
// that way. The temptation with a pricing bench is to normalise
// everything into one $/1M number and rank it; that number is wrong for
// at least five of the providers below, which is why eligibility and the
// reason for ineligibility are part of the return value rather than a
// filter applied afterwards.

type Quote struct {
	Provider string
	Plan     string
	// MonthlyUSD is the bill: base price plus metered overage, in USD.
	MonthlyUSD float64
	// PerMillionUSD is MonthlyUSD spread over the workload. It is a
	// derived convenience, not a published rate — a provider whose plan
	// bundles far more than the workload uses will show a high effective
	// rate here, which is the honest reading.
	PerMillionUSD float64
	// UnitsPerRequest is the weighted average units this profile costs on
	// this provider. It is what makes CU, RU and credits comparable at
	// all, so the bench publishes it alongside the money.
	UnitsPerRequest float64
	Eligible        bool
	// Reason is filled when Eligible is false, and is rendered on the page.
	// "Not ranked" with a stated reason beats silent omission.
	Reason     string
	Confidence string
}

// unitsPerRequest computes the weighted units one request of this
// profile costs on this provider, or reports why it cannot be computed.
func unitsPerRequest(p Provider, pr Profile) (float64, error) {
	w, ok := p.Weights[pr.Chain]
	if !ok {
		return 0, fmt.Errorf("provider does not price %s", pr.Chain)
	}
	// A provider with a real archive price list uses it wholesale, and
	// the multiplier branch below is skipped. GetBlock's archive cost is
	// 3x on debug/trace and 1.5x on the enumerated trace family, so
	// collapsing it to one multiplier would be wrong in both directions.
	usedArchiveTable := false
	if pr.Archive {
		if aw, ok := p.ArchiveWeights[pr.Chain]; ok {
			w, usedArchiveTable = aw, true
		}
	}

	total, shares := 0.0, 0.0
	for method, share := range pr.Mix {
		units, ok := w.Weight(method)
		if !ok {
			return 0, fmt.Errorf("no published unit cost for %s", method)
		}
		total += share * units
		shares += share
	}
	// Normalise by the shares actually summed rather than trusting them to
	// total exactly 1. Floating-point addition of 0.40+0.20+0.15+0.15+0.10
	// lands on 1.0000000000000002, and that 2e-16 was enough to push a
	// 1,000M-request workload two ten-millionths of a unit past a plan
	// whose allowance is exactly 1,000M — which hard-stopped it and
	// silently dropped Syndica out of a leaderboard cell it wins.
	if shares > 0 {
		total /= shares
	}

	if pr.Archive && !usedArchiveTable {
		switch p.ArchiveRule.Kind {
		case "multiplier":
			// Chainstack (2x on block age), BlockPI (+30% on the endpoint),
			// Tatum (20x on the per-call model).
			total *= p.ArchiveRule.Value
		case "additive":
			total += p.ArchiveRule.Value
		case "unpublished":
			// The provider serves archive but has never said what it
			// charges for it. Tatum is the case: its famous 20x surcharge
			// belongs to a different, coexisting pricing model and is
			// unpublished in the credit model this bench scores. Refusing
			// to price the workload is the finding; inventing a multiple
			// would be a guess wearing a decimal point.
			return 0, fmt.Errorf("archive surcharge not published")
		case "block_age", "none", "":
			// Either already encoded in the per-method weights (GetBlock
			// carries an independent archive column rather than a
			// multiplier, so its archive numbers live in the weights table)
			// or genuinely free (Alchemy, dRPC, QuickNode charge no archive
			// premium).
		}
	}
	return total, nil
}

// quote prices one profile at one monthly volume on one plan.
func quote(c *Catalogue, p Provider, pl Plan, pr Profile, requests float64) Quote {
	q := Quote{Provider: p.Slug, Plan: pl.ID, Confidence: pl.Confidence}

	// "Enterprise, contact us" cannot be ranked. Saying so is the point:
	// a quarter of the plans in this cohort have no published price, and
	// a leaderboard that silently omitted them would imply they don't
	// exist rather than that their vendors won't say.
	if pl.Confidence == "unpublished" || (pl.MonthlyUSD == nil && pl.PackagePriceUSD == nil) {
		q.Reason = "price not published (sales-gated)"
		return q
	}
	// Plans whose price carries a caveat are ranked, but the page badges
	// them: a blanket exclusion removed a quarter of the cohort including
	// PublicNode, the $0 reference row. The specific hazard it was aimed
	// at — Infura's $200 add-on, whose allowance period is ambiguous by a
	// factor of 30 — is handled properly by RequiresPlan below, which
	// prices the prerequisite the add-on cannot be bought without.

	upr, err := unitsPerRequest(p, pr)
	if err != nil {
		q.Reason = err.Error()
		return q
	}
	q.UnitsPerRequest = upr

	// Trace workloads on a plan that does not serve trace are not "more
	// expensive", they are unavailable. Same for archive.
	if pr.Archive && pl.Archive == "false" {
		q.Reason = "plan has no archive access"
		return q
	}
	if isTraceProfile(pr) && pl.Trace != nil && !*pl.Trace {
		q.Reason = "plan has no trace/debug access"
		return q
	}

	needed := requests * upr

	// Throughput is a second, independent meter, and for several
	// providers it binds before the bill does. Tatum and Moralis publish
	// 200 rps against the 386 rps a 1,000M/month workload needs; Alchemy's
	// 30,000 CU/s self-serve ceiling is 2x under what the indexer profile
	// requires and 8x under trace. In every case the money would be
	// affordable and the service still cannot be bought — that is a
	// different answer from "expensive" and the page says so.
	//
	// The check assumes perfectly flat traffic, which is the most
	// generous possible reading: real traffic bursts, so a plan that
	// fails here fails harder in practice.
	if pl.Throughput.Value != nil && *pl.Throughput.Value > 0 {
		var required float64
		switch pl.Throughput.Unit {
		case "rps":
			required = requests / (daysPerMonth * 86400)
		case "cu_per_s", "credits_per_s", "ru_per_s":
			required = needed / (daysPerMonth * 86400)
		}
		if required > *pl.Throughput.Value {
			q.Reason = fmt.Sprintf("published throughput is %.0f %s, workload needs %.0f sustained",
				*pl.Throughput.Value, pl.Throughput.Unit, math.Ceil(required))
			return q
		}
	}

	base := 0.0
	switch {
	case pl.MonthlyUSD != nil:
		base = c.toUSD(*pl.MonthlyUSD, p.Currency)
	case pl.PackagePriceUSD != nil:
		base = c.toUSD(*pl.PackagePriceUSD, p.Currency)
	}
	// Packages that expire are not monthly subscriptions. Pro-rating them
	// to 30 days is the only way they can sit in a monthly table at all,
	// and the catalogue carries the caveat that unused units are forfeited.
	base *= periodScale(pl.AllowancePeriod)

	// An add-on is only reachable on top of the plan it requires, so the
	// bill is both. Providers advertise the add-on price alone; the
	// reader pays the sum.
	if pl.RequiresPlan != "" {
		for _, pre := range p.Plans {
			if pre.ID != pl.RequiresPlan {
				continue
			}
			if pre.MonthlyUSD != nil {
				base += c.toUSD(*pre.MonthlyUSD, p.Currency) * periodScale(pre.AllowancePeriod)
			}
			break
		}
	}

	included := 0.0
	if pl.IncludedUnits != nil {
		included = *pl.IncludedUnits * periodScale(pl.AllowancePeriod)
	}
	// A daily cap is not a monthly pool. Infura's 15M credits/day cannot
	// be spent as 450M on the first of the month, so the plan is eligible
	// only if the workload fits inside the DAILY allowance.
	if pl.AllowancePeriod == "day" && pl.IncludedUnits != nil {
		if needed/daysPerMonth > *pl.IncludedUnits*(1+1e-9) {
			q.Reason = fmt.Sprintf("daily cap of %.0f %s cannot serve %.0f/day", *pl.IncludedUnits, p.Unit, needed/daysPerMonth)
			return q
		}
		q.MonthlyUSD = base
		q.Eligible = true
		q.PerMillionUSD = perMillion(q.MonthlyUSD, requests)
		return q
	}

	// Compare with a relative tolerance. A workload that exactly fills a
	// plan must count as fitting it: the arithmetic that gets us here
	// multiplies a request count by a weighted average, and no provider
	// intends "your 1,000,000,000 requests exceed your 1,000,000,000
	// allowance". The tolerance is far below any real pricing increment.
	if needed <= included*(1+1e-9) {
		q.MonthlyUSD = base
		q.Eligible = true
		q.PerMillionUSD = perMillion(q.MonthlyUSD, requests)
		return q
	}

	switch pl.OverageAllowed {
	case "hard_stop", "false":
		q.Reason = fmt.Sprintf("plan caps at %.0f %s and does not meter overage", included, p.Unit)
		return q
	}
	// A ceiling the plan cannot serve past even when overage is metered.
	// Beyond it the provider is not expensive, it is unavailable.
	if pl.MaxUnits != nil && needed > *pl.MaxUnits*(1+1e-9) {
		q.Reason = fmt.Sprintf("plan's published ceiling is %.0f %s, workload needs %.0f", *pl.MaxUnits, p.Unit, needed)
		return q
	}
	if pl.OveragePer1M == nil && len(pl.OverageBands) == 0 {
		q.Reason = "allowance exceeded and no published overage rate"
		return q
	}

	q.MonthlyUSD = base + c.overageCost(p, pl, included, needed)
	q.Eligible = true
	q.PerMillionUSD = perMillion(q.MonthlyUSD, requests)
	return q
}

// overageCost prices the units above the plan's allowance, honouring a
// sliding band table where one exists. Bands are marginal: each rate
// applies only to the units inside its own step, which is how Validation
// Cloud and thirdweb describe theirs. A flat rate is the single-band case.
func (c *Catalogue) overageCost(p Provider, pl Plan, included, needed float64) float64 {
	if needed <= included {
		return 0
	}
	if len(pl.OverageBands) == 0 {
		return ((needed - included) / 1e6) * c.toUSD(*pl.OveragePer1M, p.Currency)
	}

	total := 0.0
	// Walk the bands from the allowance ceiling upward, charging each
	// step only for the units that fall inside it.
	cursor := included
	for _, b := range pl.OverageBands {
		if cursor >= needed {
			break
		}
		top := needed
		if b.UpToUnits != nil && *b.UpToUnits < top {
			top = *b.UpToUnits
		}
		if top <= cursor {
			continue // band entirely below the allowance
		}
		total += ((top - cursor) / 1e6) * c.toUSD(b.PricePer1M, p.Currency)
		cursor = top
	}
	// Anything past the last band's ceiling is charged at that band's rate
	// rather than silently going free.
	if cursor < needed {
		last := pl.OverageBands[len(pl.OverageBands)-1]
		total += ((needed - cursor) / 1e6) * c.toUSD(last.PricePer1M, p.Currency)
	}
	return total
}

// cheapest picks a provider's best eligible plan for a workload. When no
// plan is eligible it returns the least-bad reason so the page can say
// why the provider is absent from that cell.
//
// `tier` restricts the search to one plan band ("" means any). It is
// what makes "the cheapest entry-level plan" answerable: without it the
// model would always reach for whichever plan happens to be cheapest for
// the volume, which at high volume is an enterprise plan and at low
// volume is the free tier.
func cheapest(c *Catalogue, p Provider, pr Profile, requests float64, tier string) Quote {
	best := Quote{Provider: p.Slug, Reason: "no plans published"}
	if tier != "" {
		best.Reason = "no plan in this tier"
	}
	// `all` is the default view, and it means "cheapest paid plan": a
	// free tier winning the smallest volume would bury the comparison.
	paidOnly := tier == "all"
	if paidOnly {
		tier = ""
	}
	found := false
	// When nothing is eligible, the useful explanation comes from the
	// provider's most capable plan, not the first one tried. Reporting
	// Infura's free 3M/day cap when the reader would obviously buy Team
	// would understate what the provider offers.
	bestIneligibleAllowance := -1.0
	for _, pl := range p.Plans {
		planTier := c.PlanTier(p, pl)
		if tier != "" && planTier != tier {
			continue
		}
		if paidOnly && planTier == TierFree {
			continue
		}
		q := quote(c, p, pl, pr, requests)
		if !q.Eligible {
			if found {
				continue
			}
			allowance := 0.0
			if pl.IncludedUnits != nil {
				allowance = *pl.IncludedUnits
			}
			if allowance > bestIneligibleAllowance {
				best, bestIneligibleAllowance = q, allowance
			}
			continue
		}
		if !found || q.MonthlyUSD < best.MonthlyUSD {
			best, found = q, true
		}
	}
	return best
}

// breakeven returns the monthly request count at which a fixed-price
// offering (a dedicated node, a flat-rate RPS plan) undercuts a metered
// rate. It is the question the dedicated cohort exists to answer.
func breakeven(monthlyUSD, meteredPerMillionUSD float64) float64 {
	if meteredPerMillionUSD <= 0 {
		return math.NaN()
	}
	return monthlyUSD / meteredPerMillionUSD * 1e6
}

func perMillion(monthlyUSD, requests float64) float64 {
	if requests <= 0 {
		return math.NaN()
	}
	return monthlyUSD / (requests / 1e6)
}

// periodScale normalises an allowance period onto a 30-day month.
// A 90-day package bought once covers three months, so both its price
// and its allowance are divided by three to sit in a monthly table.
func periodScale(period string) float64 {
	switch period {
	case "package_32d":
		return daysPerMonth / 32.0
	case "package_60d":
		return daysPerMonth / 60.0
	case "package_90d":
		return daysPerMonth / 90.0
	default:
		// "month", "day" and "lifetime" are handled by the caller; day
		// allowances are compared per-day and lifetime credits are not a
		// recurring plan at all.
		return 1
	}
}

func isTraceProfile(pr Profile) bool {
	for m := range pr.Mix {
		if len(m) >= 6 && (m[:6] == "debug_" || m[:6] == "trace_") {
			return true
		}
	}
	return false
}
