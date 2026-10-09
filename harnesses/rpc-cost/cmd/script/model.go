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
	// the multiplier branch below is skipped. GetBlock is the case that
	// forced it: read off its own full_cu / archive_cu columns, archive
	// costs 2x on the catch-all reads (Ethereum 20 -> 40) and 3x on the
	// enumerated debug, trace and txpool methods (40 -> 120), so
	// collapsing it to one multiplier would be wrong in both directions.
	// The 1.5x that GetBlock's published archive_multiplier implies is a
	// property of that unusable formula, not of these columns: see the
	// archive_rule note on getblock in pricing/catalogue.yml.
	usedArchiveTable := false
	if pr.Archive {
		if aw, ok := p.ArchiveWeights[pr.Chain]; ok {
			w, usedArchiveTable = aw, true
		}
	}

	total, err := weightedUnits(w, pr)
	if err != nil {
		return 0, err
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
		case "block_age":
			// Chainstack: the surcharge is real, it is just triggered by how
			// old the block is rather than by the method name. That is a
			// documentary distinction, not a computational one, and reading
			// it as a no-op priced the indexer profile at 1 RU per request
			// instead of 2, publishing $3,990 for a bill of $8,990.
			//
			// It is NOT a multiplier on the total, which is how this was
			// first written and what the 2026-09-30 audit caught. Several
			// methods already carry the doubled figure in their own weight:
			// debug_traceTransaction is listed at 2 RU and the empirical pass
			// measured 2 RU even at tip-10, so the cost is method-driven
			// there, not recency-driven. Multiplying again charged trace 3.6
			// RU against a real 2.0, an 80 % overstatement that moved the
			// winner in two cells.
			//
			// Per method, the archive weight is therefore the larger of what
			// the provider lists and what the block-age surcharge implies:
			// a base read goes 1 -> 2, a debug call already at 2 stays 2.
			var err error
			total, err = blockAgeUnits(w, pr, p.ArchiveRule.Value)
			if err != nil {
				return 0, err
			}
		case "none", "":
			// Either already encoded in the per-method weights (GetBlock
			// carries an independent archive column rather than a
			// multiplier, so its archive numbers live in archive_weights)
			// or genuinely free (Alchemy, dRPC and QuickNode charge no
			// archive premium at all).
		default:
			// An unrecognised rule must not silently price archive at par.
			return 0, fmt.Errorf("unknown archive rule %q", p.ArchiveRule.Kind)
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

	// Dedicated capacity is sold by the month or the node-hour and serves
	// requests unmetered, so it has no per-method weights and must not be
	// run through them. Its bill is the monthly price, flat, whatever the
	// workload — which is exactly what makes a break-even volume the right
	// question for it. Without this branch all nine offerings failed with
	// "provider does not price ethereum" and the cohort rendered empty.
	// Capacity sold by the month serves the chains it was provisioned for
	// and no others. This is the only chain test on the unmetered path,
	// because that path skips unitsPerRequest, where every other cohort's
	// test lives.
	if len(pl.Chains) > 0 && !servesChain(pl, pr.Chain) {
		q.Reason = fmt.Sprintf("plan does not serve %s", pr.Chain)
		return q
	}

	// Every plan in the dedicated cohort bills in `request`, so one request
	// is one unit and there are no per-method weights to resolve. It used to
	// take upr = 0 and then needed = 0, which made the overage and max_units
	// branches below unreachable for the whole cohort: AWS AMB read $97.82 at
	// every volume against a real 1B bill of $3,097.82, and Zeeve's published
	// ceilings bound nothing. Whether the requests are actually metered is
	// decided further down, by the plan, not here by the cohort.
	dedicated := p.Cohort == "dedicated"
	upr := 1.0
	if !dedicated {
		var err error
		upr, err = unitsPerRequest(p, pr)
		if err != nil {
			q.Reason = err.Error()
			return q
		}
	}

	q.UnitsPerRequest = upr

	// Trace workloads on a plan that does not serve trace are not "more
	// expensive", they are unavailable. Same for archive.
	//
	// And a plan that has never SAID must not be ranked either. Both fields
	// used to pass when null — one test looked for the string "false", the
	// other for a non-nil pointer — so 27 of the 106 usage plans were scored
	// on archive and trace workloads without having claimed support. NOWNodes
	// won trace cells that way, on a capability it makes no claim about.
	//
	// The reason distinguishes the two cases on purpose. "Does not serve" is
	// the provider's statement; "has not published" is ours, and it is a gap
	// in this catalogue rather than a limit of the product. Only the second is
	// supportable for a null, and saying which it is turns each one into a
	// research task instead of a silent omission.
	if pr.Archive {
		switch pl.Archive {
		case "false":
			q.Reason = "plan has no archive access"
			return q
		case "":
			q.Reason = "archive support for this plan is not published; not ranked"
			return q
		}
	}
	if isTraceProfile(pr) {
		if pl.Trace == nil {
			q.Reason = "trace/debug support for this plan is not published; not ranked"
			return q
		}
		if !*pl.Trace {
			q.Reason = "plan has no trace/debug access"
			return q
		}
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
		skip := false
		switch pl.Throughput.Unit {
		case "rps":
			required = requests / (daysPerMonth * 86400)
		case "cu_per_s", "credits_per_s", "ru_per_s":
			// The rate limit is metered in a different unit from the bill.
			// Alchemy charges 40 billing CU for debug_traceTransaction and
			// counts 1000 against its throughput ceiling, so checking the
			// limit against billing units understates it 25-fold. Use the
			// provider's throughput table when it has one; when that table
			// does not price every method in the profile, skip the check
			// rather than mix two units and publish the difference.
			if tw, ok := p.ThroughputWeights[pr.Chain]; ok {
				tpr, err := weightedUnits(tw, pr)
				if err != nil {
					skip = true
				} else {
					required = requests * tpr / (daysPerMonth * 86400)
				}
			} else {
				required = needed / (daysPerMonth * 86400)
			}
		default:
			skip = true
		}
		if !skip && required > *pl.Throughput.Value {
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
	} else if dedicated && pl.OveragePer1M == nil && len(pl.OverageBands) == 0 {
		// A missing included_units means two opposite things in this cohort,
		// and that ambiguity is what produced blocker 2. GetBlock's dedicated
		// node serves unlimited requests for its monthly fee; AWS AMB includes
		// none and bills every request on top. Both write null.
		//
		// The plan's own overage rate decides: publishing one means it meters
		// from the first request, publishing none means the node is flat. 33
		// of the 37 plans here are flat and must stay so; the 4 that meter
		// (AWS AMB in three regions, Shyft legacy-scale) now reach the branches
		// below.
		included = math.Inf(1)
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
	// Reference rows are the exception. They are never ranked against
	// anyone, and their only plan IS the free public endpoint, so
	// filtering it out would empty the cohort the page publishes them in.
	paidOnly := tier == "all" && !p.isReference()
	if tier == "all" {
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
		// A one-month trial is not a monthly price, at any volume and in
		// any band. Skipped for every tier rather than only the paid view:
		// a $0 trial crowning the `entry` tab is the same wrong answer as
		// a $0 trial crowning the default one. The free tiers that ARE
		// recurring stay exactly where they were, which is bench 283.
		if pl.NonRecurring {
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

// weightedUnits averages a profile's method mix against a unit table.
//
// Shares are normalised by the total actually summed rather than trusted
// to be exactly 1: floating-point addition of 0.40+0.20+0.15+0.15+0.10
// lands on 1.0000000000000002, and that 2e-16 was once enough to push a
// 1,000M-request workload two ten-millionths of a unit past a plan whose
// allowance is exactly 1,000M, hard-stopping it and dropping a provider
// out of a cell it wins.
func weightedUnits(w Weights, pr Profile) (float64, error) {
	// Fixed order, not map order: see Profile.MixOrder.
	methods := pr.MixOrder()
	if len(methods) == 0 {
		return 0, fmt.Errorf("profile declares no method mix")
	}
	base, ok := w.Weight(methods[0])
	if !ok {
		return 0, fmt.Errorf("no published unit cost for %s", methods[0])
	}
	// Shifted mean: average the distance from the first method's weight and
	// add that weight back. Algebraically the same as averaging the weights,
	// and exact in the one case that has to be exact. Ankr charges a flat 200
	// units for every method, and summing share*200 over the seven-term dapp
	// mix returned 199.99999999999994: the free allowance then came back as
	// 1,000,000.0000000002 on dapp and 1,000,000 on the other three mixes, so
	// the floor and ceiling columns reported a spread on a plan that has none
	// and called a flat-rate plan workload-sensitive. Here every term is
	// zero when the weights are uniform, and the result is that weight to the
	// bit.
	total, shares := 0.0, 0.0
	for _, method := range methods {
		share := pr.Mix[method]
		units, ok := w.Weight(method)
		if !ok {
			return 0, fmt.Errorf("no published unit cost for %s", method)
		}
		total += share * (units - base)
		shares += share
	}
	if shares <= 0 {
		return 0, fmt.Errorf("profile shares sum to zero")
	}
	return base + total/shares, nil
}

// blockAgeUnits prices a profile under a block-age archive surcharge.
//
// The surcharge raises the floor rather than scaling the bill: a method whose
// own listed weight is already at or above what the surcharge implies is
// unaffected by it. See the block_age branch in unitsPerRequest for why.
func blockAgeUnits(w Weights, pr Profile, mult float64) (float64, error) {
	if w.Default == nil {
		// Without a chain default there is nothing for the surcharge to act
		// on, and guessing one would invent the number this bench exists to
		// report. The provider's own archive table is the supported way to
		// price this; see ArchiveWeights.
		return 0, fmt.Errorf("block_age archive rule needs a chain default weight")
	}
	floor := *w.Default * mult
	// Fixed order, not map order: see Profile.MixOrder. Shifted mean for the
	// same reason as weightedUnits: a mix every one of whose methods is
	// raised to the floor must price at exactly the floor.
	methods := pr.MixOrder()
	if len(methods) == 0 {
		return 0, fmt.Errorf("profile declares no method mix")
	}
	firstUnits, ok := w.Weight(methods[0])
	if !ok {
		return 0, fmt.Errorf("no published unit cost for %s", methods[0])
	}
	base := math.Max(firstUnits, floor)
	total, shares := 0.0, 0.0
	for _, method := range methods {
		share := pr.Mix[method]
		units, ok := w.Weight(method)
		if !ok {
			return 0, fmt.Errorf("no published unit cost for %s", method)
		}
		total += share * (math.Max(units, floor) - base)
		shares += share
	}
	if shares > 0 {
		total = base + total/shares
	}
	return total, nil
}

// servesChain reports whether a plan is provisioned for a chain. An empty
// list means the weights table decides, which is right for a per-request
// plan and wrong for a dedicated node, so validate() requires the list on
// the dedicated cohort.
func servesChain(pl Plan, chain string) bool {
	for _, c := range pl.Chains {
		if c == chain {
			return true
		}
	}
	return false
}
