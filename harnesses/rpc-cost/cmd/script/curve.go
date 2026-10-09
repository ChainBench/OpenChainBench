package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
)

// Emits the cost curve so a reader can move a slider instead of picking one
// of three published volumes.
//
// What is emitted is the CURVE, not the pricing parameters. Shipping the
// catalogue and recomputing in the browser was the obvious design and it is
// wrong: eligibility moves with volume. A daily allowance stops serving once
// the daily rate passes it, `overage_allowed: hard_stop` makes a plan
// unbuyable above its included units rather than merely expensive, a plan
// with a prerequisite carries the prerequisite's price, and overage can be
// banded. Reimplementing that in TypeScript would be a second pricing engine
// to keep in step with this one, and the two would eventually disagree about
// what a provider charges. That is the failure this bench exists to avoid.
//
// So the arithmetic stays here, called through the same cheapest() the
// Prometheus path uses, and the browser only interpolates between points.
//
// Between two adjacent breakpoints the bill is affine in the request count:
// units scale linearly with requests (unitsPerRequest does not depend on
// volume), and within one overage band the rate is constant. So the curve is
// exact at every emitted point and linear in between, which is the real
// shape and not a smoothing.

// curveSchema is the shape of the artifact. Bump it when fields change: the
// reader checks it and refuses a shape it does not know, rather than
// decoding missing fields into zeros and drawing a free plan.
const curveSchema = 1

// curveFloor and curveCeiling bound the slider. Below 100k requests every
// plan is its base price and the comparison says nothing; above 5B the
// cohort is enterprise quotes nobody publishes.
const (
	curveFloor   = 100_000.0
	curveCeiling = 5_000_000_000.0
)

type CurvePoint struct {
	Requests float64 `json:"r"`
	// MonthlyUSD is nil where no plan of this provider can serve the
	// volume. A gap is not a zero, and the reader has to be able to tell
	// them apart: the board already shipped five providers at $0 once.
	MonthlyUSD *float64 `json:"usd"`
	Plan       string   `json:"plan,omitempty"`
	Reason     string   `json:"why,omitempty"`
}

type CurveProvider struct {
	Slug   string       `json:"slug"`
	Name   string       `json:"name"`
	Cohort string       `json:"cohort"`
	Unit   string       `json:"unit"`
	Points []CurvePoint `json:"points"`
}

type CurveProfile struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	Chain     string          `json:"chain"`
	Providers []CurveProvider `json:"providers"`
}

type CurveFile struct {
	Schema    int            `json:"schema"`
	Version   int            `json:"catalogueVersion"`
	AsOf      string         `json:"catalogueAsOf"`
	Floor     float64        `json:"floor"`
	Ceiling   float64        `json:"ceiling"`
	Profiles  []CurveProfile `json:"profiles"`
	Generated string         `json:"generatedBy"`
}

// breakpoints returns the request counts where this provider's bill can
// change slope or switch plan: every allowance ceiling and every overage
// band edge, converted from units back into requests.
//
// Sampling on a fixed grid instead would miss these corners, and a corner is
// exactly where the interesting answer lives: the volume at which a cheap
// plan runs out and the next one takes over.
func breakpoints(c *Catalogue, p Provider, pr Profile) []float64 {
	upr, err := unitsPerRequest(p, pr)
	if err != nil || upr <= 0 {
		return nil
	}
	var out []float64
	add := func(units float64) {
		r := units / upr
		if r > curveFloor && r < curveCeiling {
			// Both sides of the corner: the last request the allowance
			// covers and the first one it does not.
			out = append(out, math.Nextafter(r, 0), r, math.Nextafter(r, curveCeiling))
		}
	}
	for _, pl := range p.Plans {
		if pl.IncludedUnits != nil {
			add(*pl.IncludedUnits * periodScale(pl.AllowancePeriod))
		}
		for _, b := range pl.OverageBands {
			if b.UpToUnits != nil {
				add(*b.UpToUnits)
			}
		}
	}
	return out
}

// refine subdivides wherever a straight line between two points would lie to
// the reader, and keeps subdividing until it would not.
//
// Two earlier attempts were too clever. Collecting each plan's allowance
// ceilings and band edges finds the corners of each plan's own line, but the
// board shows the CHEAPEST plan at each volume, and the handover between two
// plans happens where their lines cross, which is a corner of neither.
// Bisecting on a change of plan id then fixed that case and missed the next:
// the dedicated cohort scales by adding nodes, so its bill steps from $150 to
// $300 while the plan id never changes. Checked against the published gauges,
// GetBlock dedicated read $295 at 10M requests against a real $150.
//
// Enumerating the kinds of discontinuity was the mistake. This converges on
// the function instead: evaluate the midpoint, and if the straight line
// between the ends misses it, keep the midpoint and recurse on both halves.
// Plan handovers, node steps, banded overage and daily caps all fall out of
// the same test, because all of them are just places where the line is wrong.
//
// Two things bound the work, and both are needed. Depth alone is not enough:
// the dedicated cohort scales by adding nodes, so its bill is a staircase of
// many small steps, every interval fails the straightness test, and the
// recursion splits all the way down everywhere. The first run of this
// produced a 421 MB artifact.
//
// So refinement also stops once an interval is narrower than a fifth of a
// percent in relative terms, which is finer than any volume a reader can
// pick on a slider, and the caller holds a per-provider budget.
const (
	refineMaxDepth   = 12
	refineMinSpan    = 1.002 // hi/lo below this and the step is pinned enough
	refineMaxPerPair = 120
)

func refine(
	c *Catalogue, p Provider, pr Profile,
	lo, hi float64, loUSD, hiUSD *float64, loPlan, hiPlan string,
	depth int, out *[]float64,
) {
	if depth <= 0 || hi <= lo*refineMinSpan || len(*out) >= refineMaxPerPair {
		return
	}
	// Neither end is buyable: there is nothing between them to find. Without
	// this the hunt walks the whole unbuyable range looking for a boundary
	// that is not there, and a provider priced out of most volumes emits
	// thousands of identical "no plan serves this" points. 1rpc alone
	// contributed 2,908 of them per profile, and the artifact came to 5.6 MB
	// of which 98% was that.
	if loUSD == nil && hiUSD == nil {
		return
	}
	mid := lo + (hi-lo)/2
	if mid <= lo || mid >= hi {
		return
	}
	q := cheapest(c, p, pr, mid, "all")
	var midUSD *float64
	midPlan := ""
	if q.Eligible {
		v := q.MonthlyUSD
		midUSD, midPlan = &v, q.Plan
	}

	// A change of eligibility or of plan is a step by definition: keep the
	// point and look on both sides for where exactly it happens.
	straight := loUSD != nil && hiUSD != nil && midUSD != nil &&
		loPlan == midPlan && midPlan == hiPlan
	if straight {
		want := *loUSD + (*hiUSD-*loUSD)/2
		tol := math.Max(0.01, math.Abs(*midUSD)*0.0005)
		if math.Abs(want-*midUSD) <= tol {
			return // the line already tells the truth here
		}
	}
	*out = append(*out, mid)
	refine(c, p, pr, lo, mid, loUSD, midUSD, loPlan, midPlan, depth-1, out)
	refine(c, p, pr, mid, hi, midUSD, hiUSD, midPlan, hiPlan, depth-1, out)
}

// refineAll runs refine over every adjacent pair of the starting grid.
func refineAll(c *Catalogue, p Provider, pr Profile, xs []float64) []float64 {
	eval := func(x float64) (*float64, string) {
		q := cheapest(c, p, pr, x, "all")
		if !q.Eligible {
			return nil, ""
		}
		v := q.MonthlyUSD
		return &v, q.Plan
	}
	extra := []float64{}
	for i := 0; i+1 < len(xs); i++ {
		lv, lp := eval(xs[i])
		hv, hp := eval(xs[i+1])
		// Budget per pair, not per provider, so a staircase early in the
		// range cannot starve the rest of the curve.
		pair := []float64{}
		refine(c, p, pr, xs[i], xs[i+1], lv, hv, lp, hp, refineMaxDepth, &pair)
		extra = append(extra, pair...)
	}
	out := append(append([]float64{}, xs...), extra...)
	sort.Float64s(out)
	return out
}

// logGrid is the backbone the breakpoints are laid onto, so a provider with
// no corners at all still draws a line.
func logGrid(n int) []float64 {
	out := make([]float64, 0, n)
	lo, hi := math.Log10(curveFloor), math.Log10(curveCeiling)
	for i := 0; i < n; i++ {
		out = append(out, math.Pow(10, lo+(hi-lo)*float64(i)/float64(n-1)))
	}
	return out
}

// BuildCurves evaluates every provider against every workload profile at
// each breakpoint, through the same cheapest() the gauges use.
func BuildCurves(c *Catalogue) CurveFile {
	f := CurveFile{
		Schema:    curveSchema,
		Version:   c.Version,
		AsOf:      c.AsOf,
		Floor:     curveFloor,
		Ceiling:   curveCeiling,
		Generated: "harnesses/rpc-cost, RPC_COST_EMIT_CURVES",
	}
	grid := logGrid(36)

	for _, pr := range Profiles {
		cp := CurveProfile{ID: pr.ID, Label: pr.Label, Chain: pr.Chain}
		for _, p := range c.Providers {
			// The slider has to carry exactly the cohort the gauges carry,
			// or the two surfaces of one bench disagree about who is in the
			// market. priceEverything() drops these two groups, so this does
			// too, for the same two reasons.
			//
			// An excluded provider publishes no series at all: it is in the
			// catalogue to record why it is not comparable (no public
			// pricing, a staking model, a quote-only enterprise desk), not
			// to be priced. Emitting it here would put a row on the slider
			// that the ledger beneath it does not have.
			if p.Cohort == "excluded" {
				continue
			}
			// Reference rows are published but never ranked, and the slider
			// is a ranking surface. Leaving them in would put a free public
			// endpoint at the top of a cost board at every volume.
			if p.isReference() {
				continue
			}
			xs := append(append([]float64{}, grid...), breakpoints(c, p, pr)...)
			sort.Float64s(xs)
			xs = refineAll(c, p, pr, xs)

			pts := make([]CurvePoint, 0, len(xs))
			for i, x := range xs {
				if i > 0 && x == xs[i-1] {
					continue
				}
				q := cheapest(c, p, pr, x, "all")
				pt := CurvePoint{Requests: x}
				if q.Eligible {
					v := q.MonthlyUSD
					pt.MonthlyUSD = &v
					pt.Plan = q.Plan
				} else {
					pt.Reason = q.Reason
				}
				// Thinning happens once, in dropCollinear, and not here.
				// Dropping each point that merely repeats its predecessor
				// looks equivalent and is not: a flat run collapses to its
				// FIRST point, so the last flat point disappears — and that
				// one is the corner where the allowance runs out. Chainstack
				// then went straight from ($49 at 100k) to ($140 at 26M),
				// and reading 10M off that line gave $84 against a real $49.
				// dropCollinear keeps corners by construction, because a
				// corner is where the line is wrong.
				pts = append(pts, pt)
			}
			pts = dropCollinear(round(pts))
			if len(pts) == 0 {
				continue
			}
			cp.Providers = append(cp.Providers, CurveProvider{
				Slug: p.Slug, Name: p.Name, Cohort: p.Cohort, Unit: p.Unit, Points: pts,
			})
		}
		sort.Slice(cp.Providers, func(i, j int) bool { return cp.Providers[i].Slug < cp.Providers[j].Slug })
		f.Profiles = append(f.Profiles, cp)
	}
	return f
}

// dropCollinear removes the middle of any three points the reader would
// reconstruct anyway. A metered plan with no allowance is one straight line
// from the floor to the ceiling, and emitting the 36 grid points along it
// costs bytes on every page load to say nothing. Corners survive, because
// a corner is precisely where the middle point is NOT on the line.
//
// The tolerance is a cent or a thousandth of the value, whichever is larger,
// so a $10,000 enterprise curve is not held to the same absolute precision
// as a $0.55 one.
func dropCollinear(in []CurvePoint) []CurvePoint {
	if len(in) < 3 {
		return in
	}
	in = collapseGaps(in)
	if len(in) < 3 {
		return in
	}
	out := []CurvePoint{in[0]}
	for i := 1; i < len(in)-1; i++ {
		a, b, c := out[len(out)-1], in[i], in[i+1]
		if a.MonthlyUSD == nil || b.MonthlyUSD == nil || c.MonthlyUSD == nil ||
			a.Plan != b.Plan || b.Plan != c.Plan {
			out = append(out, b)
			continue
		}
		span := c.Requests - a.Requests
		if span <= 0 {
			out = append(out, b)
			continue
		}
		t := (b.Requests - a.Requests) / span
		want := *a.MonthlyUSD + t*(*c.MonthlyUSD-*a.MonthlyUSD)
		tol := math.Max(0.01, math.Abs(*b.MonthlyUSD)*0.001)
		if math.Abs(want-*b.MonthlyUSD) > tol {
			out = append(out, b)
		}
	}
	return append(out, in[len(in)-1])
}

// collapseGaps reduces a run of "no plan serves this volume" to its two
// ends. The refinement hunts the exact request count where a provider stops
// being buyable, which is worth one point either side and no more — but the
// hunt leaves a trail of identical points behind it, and a cohort with
// hard-stop plans turned a 150 KB artifact into 53 MB of them.
//
// Both ends are kept, never one: the reader needs to know where the gap
// opens and where it closes.
func collapseGaps(in []CurvePoint) []CurvePoint {
	out := make([]CurvePoint, 0, len(in))
	for i := 0; i < len(in); i++ {
		if in[i].MonthlyUSD != nil {
			out = append(out, in[i])
			continue
		}
		j := i
		for j+1 < len(in) && in[j+1].MonthlyUSD == nil && in[j+1].Reason == in[i].Reason {
			j++
		}
		out = append(out, in[i])
		if j > i {
			out = append(out, in[j])
		}
		i = j
	}
	return out
}

// round trims the precision the reader cannot use. Requests are whole
// requests; a bill is quoted to the cent. Full float tails tripled the
// artifact and would churn the committed diff on every regeneration.
func round(pts []CurvePoint) []CurvePoint {
	for i := range pts {
		pts[i].Requests = math.Round(pts[i].Requests)
		if pts[i].MonthlyUSD != nil {
			v := math.Round(*pts[i].MonthlyUSD*100) / 100
			pts[i].MonthlyUSD = &v
		}
	}
	return pts
}

// WriteCurves renders the artifact. Written atomically so a reader never
// sees a half-file, and with a trailing newline so the committed artifact
// diffs cleanly when a vendor changes a price.
func WriteCurves(c *Catalogue, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	buf, err := json.MarshalIndent(BuildCurves(c), "", " ")
	if err != nil {
		return err
	}
	buf = append(buf, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %s (%d profiles, %.0f KB)\n", path, len(BuildCurves(c).Profiles), float64(len(buf))/1024)
	return nil
}
