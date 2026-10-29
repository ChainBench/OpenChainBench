package main

import (
	"strings"
	"testing"
)

const header = `version: 1
as_of: "2026-10-29"
profiles: [{ id: p, label: P, tx_per_user: 5, new_user_share: 0.2 }]
volumes: [{ id: v, mau: 1000 }]
headline: { profile: p, volume: v }
curve_floor: 100
curve_ceiling: 1000000
providers:
`

const source = `
    source:
      pricing: { url: "https://example.test", verified_at: "2026-10-29", poll: true }`

// Each case is a shape that would publish a plausible wrong price rather
// than fail. All of them must be refused at load.
func TestValidationFailsClosed(t *testing.T) {
	cases := map[string]string{
		"rate missing reads as free": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 } }
    plans:
      - { id: x, name: X, monthly_usd: 10, confidence: verified, tiers: { mau: [{ up_to: 100, rate: 0 }, {}] } }` + source,
		"quote with a price attached": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 } }
    plans:
      - { id: ok, name: OK, monthly_usd: 1, confidence: verified, tiers: { mau: [{ rate: 0.1 }] } }
      - { id: q, name: Q, monthly_usd: null, confidence: verified, caps: { mau: 10 } }` + source,
		"meter neither priced nor bounded": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 }, signatures: { per_tx: 1 } }
    plans:
      - { id: x, name: X, monthly_usd: 10, confidence: verified, tiers: { mau: [{ rate: 0.1 }] } }` + source,
		"misspelt key": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 } }
    plans:
      - { id: x, name: X, monthy_usd: 10, confidence: verified, tiers: { mau: [{ rate: 0.1 }] } }` + source,
		"bounded last tier": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 } }
    plans:
      - { id: x, name: X, monthly_usd: 10, confidence: verified, tiers: { mau: [{ up_to: 100, rate: 0 }] } }` + source,
		"tier on an undefined meter": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 } }
    plans:
      - { id: x, name: X, monthly_usd: 10, confidence: verified, tiers: { mau: [{ rate: 0.1 }], ops: [{ rate: 1 }] } }` + source,
		"meter that bills nothing": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: {} }
    plans:
      - { id: x, name: X, monthly_usd: 10, confidence: verified, tiers: { mau: [{ rate: 0.1 }] } }` + source,
		"excluded without a reason": `
  - slug: a
    name: A
    cohort: excluded`,
		"confidence missing": `
  - slug: a
    name: A
    cohort: ranked
    meters: { mau: { per_user: 1 } }
    plans:
      - { id: x, name: X, monthly_usd: 10, tiers: { mau: [{ rate: 0.1 }] } }` + source,
	}
	for name, body := range cases {
		_, err := ParseCatalogue([]byte(header + strings.TrimPrefix(body, "\n")))
		t.Logf("%s -> %v", name, err)
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The committed catalogue must load, and every polled source must carry the
// hash a human recorded when reading it, or drift detection is armed with
// nothing to compare against (rpc-cost shipped like that for weeks).
func TestCommittedCatalogueIsPinned(t *testing.T) {
	c := loadReal(t)
	for _, p := range c.Ranked() {
		for name, a := range p.Source {
			if a.Poll && len(a.BodySHA256) != 64 {
				t.Errorf("%s/%s: polled without a recorded sha256", p.Slug, name)
			}
		}
	}
}
