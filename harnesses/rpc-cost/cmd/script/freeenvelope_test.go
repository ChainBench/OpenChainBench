package main

import (
	"math"
	"testing"
)

// The envelope has to bracket every workload it was computed from, on the
// chain it was computed for. The failure this guards against is a span that
// quietly excludes one of its own endpoints: the figure the table shows for
// a workload would then sit outside the range printed beside it, and the
// range is the whole reason the columns exist.
func TestFreeEnvelopeBracketsEveryWorkloadItServes(t *testing.T) {
	c := realCatalogue(t)
	for _, p := range c.Providers {
		envs := c.FreeEnvelopes(p)
		for _, pr := range Profiles {
			reqs, _, ok := c.FreeAllowanceRequests(p, pr)
			if !ok {
				continue
			}
			e, seen := envs[pr.Chain]
			if !seen {
				t.Errorf("%s publishes %s (%s) at %.0f with no envelope for that chain",
					p.Slug, pr.ID, pr.Chain, reqs)
				continue
			}
			if reqs < e.Lo || reqs > e.Hi {
				t.Errorf("%s/%s on %s: %.0f outside envelope [%.0f, %.0f]",
					p.Slug, pr.ID, pr.Chain, reqs, e.Lo, e.Hi)
			}
		}
	}
}

// No envelope for a chain the plan does not serve. Reporting one would put a
// range on the Solana tab for an Ethereum-only plan, which is the same class
// of bug as the dRPC Solana allowance: a number standing where there is no
// measurement.
func TestFreeEnvelopeOnlyCoversChainsWithAWorkload(t *testing.T) {
	c := realCatalogue(t)
	for _, p := range c.Providers {
		for chain := range c.FreeEnvelopes(p) {
			served := false
			for _, pr := range Profiles {
				if pr.Chain != chain {
					continue
				}
				if _, _, ok := c.FreeAllowanceRequests(p, pr); ok {
					served = true
					break
				}
			}
			if !served {
				t.Errorf("%s reports an envelope for %s with no publishable workload there", p.Slug, chain)
			}
		}
	}
}

// Ethereum and Solana are separate spans, never one. Folding them printed
// 750k to 1.9M for Alchemy, a range across two chains that no application
// occupies, and it hid that the Solana figure sits above the entire Ethereum
// range rather than inside it.
func TestFreeEnvelopeDoesNotSpanChains(t *testing.T) {
	c := realCatalogue(t)
	chains := map[string]bool{}
	for _, pr := range Profiles {
		chains[pr.Chain] = true
	}
	if len(chains) < 2 {
		t.Skip("one chain declared, nothing to separate")
	}
	for _, p := range c.Providers {
		envs := c.FreeEnvelopes(p)
		if len(envs) < 2 {
			continue
		}
		// Every reported span must be reachable by the profiles of its own
		// chain alone: recomputing per chain has to reproduce it exactly.
		for chain, e := range envs {
			var lo, hi float64
			first := true
			for _, pr := range Profiles {
				if pr.Chain != chain {
					continue
				}
				reqs, _, ok := c.FreeAllowanceRequests(p, pr)
				if !ok {
					continue
				}
				if first {
					lo, hi, first = reqs, reqs, false
					continue
				}
				if reqs < lo {
					lo = reqs
				}
				if reqs > hi {
					hi = reqs
				}
			}
			if e.Lo != lo || e.Hi != hi {
				t.Errorf("%s/%s envelope [%.0f, %.0f] does not match that chain's own workloads [%.0f, %.0f]",
					p.Slug, chain, e.Lo, e.Hi, lo, hi)
			}
		}
	}
}

// A plan that meters flat reports floor equal to ceiling, and one weighted
// per method does not. This is the fact the two columns exist to surface, so
// pin that the shipped catalogue still produces both shapes: if every plan
// came back flat the columns would be three copies of one number and the
// spread this bench reports would have come from somewhere else.
func TestFreeEnvelopeSeparatesFlatPlansFromWeightedOnes(t *testing.T) {
	c := realCatalogue(t)
	flat, weighted := 0, 0
	for _, p := range c.Providers {
		e, ok := c.FreeEnvelopes(p)["ethereum"]
		if !ok || e.Hi <= 0 {
			continue
		}
		if e.Lo == e.Hi {
			flat++
		} else {
			weighted++
		}
	}
	if flat == 0 {
		t.Error("no free plan on Ethereum reports a flat allowance; one of Ankr, dRPC, OnFinality or InstaNodes should")
	}
	if weighted == 0 {
		t.Error("no free plan on Ethereum reports a spread; BlockPI, Alchemy, Infura and Blockdaemon all weight per method")
	}
	t.Logf("ethereum free plans: %d flat, %d weighted", flat, weighted)
}

// A plan whose allowance is the same on every workload it serves must report
// floor equal to ceiling exactly, not to within a rounding error.
//
// This is the claim the two columns make about flat-rate plans, and it was
// false before the shifted mean in weightedUnits: Ankr charges 200 units for
// every method, the seven-term dapp mix averaged them to 199.99999999999994,
// and the board published a free allowance of 1,000,000.0000000002 beside a
// floor of 1,000,000. Display rounding hid it, which is the only reason it
// would have shipped. A span of two ten-millionths of a request is not a
// span, and a page that prints one is claiming a measurement it does not
// have.
func TestFlatRatePlanReportsNoSpread(t *testing.T) {
	c := realCatalogue(t)
	checked := 0
	for _, p := range c.Providers {
		for chain := range c.FreeEnvelopes(p) {
			var first float64
			uniform, seen := true, false
			for _, pr := range Profiles {
				if pr.Chain != chain {
					continue
				}
				reqs, _, ok := c.FreeAllowanceRequests(p, pr)
				if !ok {
					continue
				}
				if !seen {
					first, seen = reqs, true
					continue
				}
				// Within a hair: the question is whether the pricing is flat,
				// and 1e-9 relative is far below any real plan difference and
				// far above float residue.
				if math.Abs(reqs-first) > math.Abs(first)*1e-9 {
					uniform = false
					break
				}
			}
			if !seen || !uniform {
				continue
			}
			checked++
			e := c.FreeEnvelopes(p)[chain]
			if e.Lo != e.Hi {
				t.Errorf("%s on %s buys the same %.10g requests on every workload it serves, yet reports floor %.10g and ceiling %.10g",
					p.Slug, chain, first, e.Lo, e.Hi)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no flat-allowance plan found; this test would pass vacuously")
	}
	t.Logf("%d flat-allowance plan/chain pairs checked", checked)
}
