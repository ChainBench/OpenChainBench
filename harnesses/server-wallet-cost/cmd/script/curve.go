package main

import (
	"encoding/json"
	"math"
	"os"
	"sort"
)

// The calculator's data. The site draws a slider over any MAU count by
// interpolating between these points, so the points must sit on every
// corner of every bill or a straight line will cut across something that is
// not straight. rpc-cost learned that three times: a plan crossover is a
// corner of neither plan, a stepped plan has corners the plan id never
// shows, and thinning identical points deletes the corner where an
// allowance runs out. So nothing is sampled and nothing is thinned:
//
//   - every tier boundary, cap and quote threshold of every plan, converted
//     from units to MAU for this profile;
//   - the MAU where a minimum-fee plan's charges reach its fee;
//   - every crossing between two plans' lines inside a segment;
//   - and just past each cap or quote threshold a second point, because the
//     bill jumps there (to a dearer plan, or to no price at all).
//
// Between two consecutive points every plan is affine and the set of
// eligible plans is constant, so linear interpolation is exact.

type CurvePoint struct {
	MAU  float64  `json:"x"`
	USD  *float64 `json:"usd"`
	Plan string   `json:"plan,omitempty"`
	Why  string   `json:"why,omitempty"`
	// Next is the plan that is cheapest on the open segment from this point
	// to the following one, read at the segment's midpoint. A point can sit
	// on a crossover or a cap, where its own plan is the tie-break or the
	// last plan before a switch, so naming the plan from either end would
	// mislabel up to half the segment. Empty when nothing serves the segment
	// and on the last point.
	Next string `json:"next,omitempty"`
	// Unc marks a price read one of two ways at this point; NextUnc the
	// same for the segment after it. Per point rather than per plan,
	// because a caveat can start partway along a plan (uncertain_above).
	Unc     bool `json:"unc,omitempty"`
	NextUnc bool `json:"nextUnc,omitempty"`
	// Bound / NextBound: "upper" or "lower" when the uncertain price is a
	// known bound (see Plan.Bound).
	Bound     string `json:"bound,omitempty"`
	NextBound string `json:"nextBound,omitempty"`
}

type CurveProvider struct {
	Slug   string       `json:"slug"`
	Name   string       `json:"name"`
	Unit   string       `json:"unit"`
	Points []CurvePoint `json:"points"`
}

type CurveScenario struct {
	Scenario
	Providers []CurveProvider `json:"providers"`
}

type CurveExcluded struct {
	Slug   string `json:"slug"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type CurveFile struct {
	Schema           int                          `json:"schema"`
	CatalogueVersion int                          `json:"catalogueVersion"`
	CatalogueAsOf    string                       `json:"catalogueAsOf"`
	CatalogueSHA256  string                       `json:"catalogueSha256"`
	Headline         Headline                     `json:"headline"`
	PlanNames        map[string]map[string]string `json:"planNames"`
	Notes            map[string]string            `json:"notes"`
	Excluded         []CurveExcluded              `json:"excluded"`
	Scenarios        []CurveScenario              `json:"scenarios"`
	GeneratedBy      string                       `json:"generatedBy"`
}

const jump = 2 * epsilon

func BuildCurves(c *Catalogue) CurveFile {
	out := CurveFile{
		Schema:           1,
		CatalogueVersion: c.Version,
		CatalogueAsOf:    c.AsOf,
		CatalogueSHA256:  c.SHA256,
		Headline:         c.Headline,
		PlanNames:        map[string]map[string]string{},
		Notes:            map[string]string{},
		GeneratedBy:      "harnesses/server-wallet-cost, SERVER_WALLET_COST_EMIT_CURVES",
	}
	for _, p := range c.Providers {
		if p.Cohort == "excluded" {
			out.Excluded = append(out.Excluded, CurveExcluded{Slug: p.Slug, Name: p.Name, Reason: p.ExcludedReason})
			continue
		}
		names := map[string]string{}
		for _, pl := range p.Plans {
			names[pl.ID] = pl.Name
		}
		out.PlanNames[p.Slug] = names
		if p.Note != "" {
			out.Notes[p.Slug] = p.Note
		}
	}
	for _, s := range c.Scenarios {
		cs := CurveScenario{Scenario: s}
		for _, p := range c.Ranked() {
			cs.Providers = append(cs.Providers, CurveProvider{
				Slug:   p.Slug,
				Name:   p.Name,
				Unit:   p.Unit,
				Points: curveFor(p, s),
			})
		}
		out.Scenarios = append(out.Scenarios, cs)
	}
	return out
}

func curveFor(p Provider, s Scenario) []CurvePoint {
	lo, hi := s.Floor, s.Ceiling
	xs := []float64{lo, hi}
	for _, z := range s.Sizes {
		xs = append(xs, z.X)
	}
	inRange := func(x float64) bool { return x >= lo && x <= hi }
	add := func(units float64, meter string, discontinuous bool) {
		m := p.Meters[meter]
		k := coefficient(m, s)
		if k <= 0 {
			// A meter that does not move with x (a bot's fixed 20 wallets)
			// has no boundary along the axis: the plan is in or out at
			// every x, and pricePlan already says which.
			return
		}
		x := (units - offset(m, s)) / k
		if inRange(x) {
			xs = append(xs, x)
		}
		if discontinuous {
			// Placed by quantity, not by x: with a fixed offset (a bot's 20
			// wallets) x*(1+jump) can leave the quantity under over()'s
			// tolerance, so both points would sit on the same side.
			if x2 := (units*(1+jump) - offset(m, s)) / k; inRange(x2) {
				xs = append(xs, x2)
			}
		}
	}
	for _, pl := range p.Plans {
		if pl.MonthlyUSD == nil {
			continue
		}
		for meter, tiers := range pl.Tiers {
			for _, t := range tiers {
				if t.UpTo != nil {
					add(*t.UpTo, meter, false)
				}
			}
		}
		for meter, v := range pl.Caps {
			add(v, meter, true)
		}
		for meter, v := range pl.QuoteAbove {
			add(v, meter, true)
		}
		for meter, v := range pl.UncertainAbove {
			add(v, meter, false)
		}
		if pl.Minimum {
			if x, ok := minimumKink(p, pl, s, lo, hi); ok {
				xs = append(xs, x)
			}
		}
	}
	xs = uniqueSorted(xs)
	xs = withCrossings(p, s, xs)

	pts := make([]CurvePoint, 0, len(xs))
	for i, x := range xs {
		q := cheapest(p, s, x)
		pt := CurvePoint{MAU: x}
		if q.Eligible {
			v := q.MonthlyUSD
			pt.USD, pt.Plan, pt.Unc, pt.Bound = &v, q.Plan, q.Confidence != "verified", q.Bound
		} else {
			pt.Why = q.Reason
		}
		if i+1 < len(xs) {
			if m := cheapest(p, s, (x+xs[i+1])/2); m.Eligible {
				pt.Next, pt.NextUnc, pt.NextBound = m.Plan, m.Confidence != "verified", m.Bound
			}
		}
		pts = append(pts, pt)
	}
	return pts
}

// minimumKink finds the MAU where a minimum-fee plan's metered charges
// reach its fee. Charges are continuous and non-decreasing in MAU, so
// bisection converges on the single crossing when there is one.
func minimumKink(p Provider, pl Plan, pr Scenario, lo, hi float64) (float64, bool) {
	fee := *pl.MonthlyUSD
	charges := func(x float64) float64 {
		s := 0.0
		for meter, tiers := range pl.Tiers {
			s += graduated(quantity(p.Meters[meter], pr, x), tiers)
		}
		return s
	}
	if charges(lo) >= fee || charges(hi) <= fee {
		return 0, false
	}
	a, b := lo, hi
	for i := 0; i < 200; i++ {
		m := (a + b) / 2
		if charges(m) < fee {
			a = m
		} else {
			b = m
		}
	}
	return b, true
}

// withCrossings adds, inside each segment, every point where two eligible
// plans' bills cross. Within a segment each plan is affine, so a crossing
// is the intersection of two lines and the lower envelope turns there.
func withCrossings(p Provider, pr Scenario, xs []float64) []float64 {
	out := append([]float64(nil), xs...)
	for i := 0; i+1 < len(xs); i++ {
		a, b := xs[i], xs[i+1]
		if (b-a)/a < 1e-6 {
			// A jump segment (x, x*(1+jump)): eligibility differs at its two
			// ends, so its lines are not comparable and it is too narrow to
			// hold a crossing anyone could see.
			continue
		}
		mid := (a + b) / 2
		type line struct{ ya, yb float64 }
		var lines []line
		for _, pl := range p.Plans {
			if r := pricePlan(p, pl, pr, mid); !r.ok {
				continue
			}
			ra, rb := pricePlan(p, pl, pr, a), pricePlan(p, pl, pr, b)
			if !ra.ok || !rb.ok {
				continue
			}
			lines = append(lines, line{ra.bill, rb.bill})
		}
		for j := 0; j < len(lines); j++ {
			for k := j + 1; k < len(lines); k++ {
				d0 := lines[j].ya - lines[k].ya
				d1 := lines[j].yb - lines[k].yb
				if d0 == 0 || d1 == 0 || (d0 > 0) == (d1 > 0) {
					continue
				}
				t := d0 / (d0 - d1)
				if x := a + t*(b-a); x > a && x < b {
					out = append(out, x)
				}
			}
		}
	}
	return uniqueSorted(out)
}

func uniqueSorted(xs []float64) []float64 {
	sort.Float64s(xs)
	out := xs[:0]
	for _, x := range xs {
		if len(out) > 0 && math.Abs(x-out[len(out)-1]) <= out[len(out)-1]*1e-12 {
			continue
		}
		out = append(out, x)
	}
	return out
}

func WriteCurves(c *Catalogue, path string) error {
	b, err := json.MarshalIndent(BuildCurves(c), "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
