package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"sort"
	"time"

	"gopkg.in/yaml.v3"
)

// The catalogue is the harness's only input: human-verified prices, the
// workload profiles and the volumes. See pricing/catalogue.yml for the
// model in prose. Loading validates it and FAILS CLOSED: rpc-cost's five
// worst bugs were each a value never stated being read as zero or one, and
// every one of them produced a plausible wrong price rather than an error.

type Catalogue struct {
	Version      int        `yaml:"version"`
	AsOf         string     `yaml:"as_of"`
	Profiles     []Profile  `yaml:"profiles"`
	Volumes      []Volume   `yaml:"volumes"`
	Headline     Headline   `yaml:"headline"`
	CurveFloor   float64    `yaml:"curve_floor"`
	CurveCeiling float64    `yaml:"curve_ceiling"`
	Providers    []Provider `yaml:"providers"`
	// SHA256 of the catalogue file's bytes. The curve file carries it and
	// `pnpm validate` recomputes it, so any edit to a price that is not
	// followed by a curve regeneration fails CI instead of shipping a slider
	// that quotes the old figure.
	SHA256 string `yaml:"-"`
}

type Profile struct {
	ID           string  `yaml:"id" json:"id"`
	Label        string  `yaml:"label" json:"label"`
	TxPerUser    float64 `yaml:"tx_per_user" json:"txPerUser"`
	NewUserShare float64 `yaml:"new_user_share" json:"newUserShare"`
}

type Volume struct {
	ID  string  `yaml:"id"`
	MAU float64 `yaml:"mau"`
}

type Headline struct {
	Profile string `yaml:"profile" json:"profile"`
	Volume  string `yaml:"volume" json:"volume"`
}

// Meter is a billed quantity as a linear function of the workload.
type Meter struct {
	PerUser      float64 `yaml:"per_user"`
	PerTx        float64 `yaml:"per_tx"`
	PerNewWallet float64 `yaml:"per_new_wallet"`
}

// Tier is one band of a graduated price on the TOTAL quantity of a meter.
// UpTo nil means unbounded, and only the last tier may be unbounded.
type Tier struct {
	UpTo *float64 `yaml:"up_to"`
	Rate *float64 `yaml:"rate"`
}

type Plan struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name"`
	// nil is a quote (no published price), never free.
	MonthlyUSD *float64 `yaml:"monthly_usd"`
	// Minimum turns the fee into a spending floor: max(fee, charges).
	Minimum    bool               `yaml:"minimum"`
	Confidence string             `yaml:"confidence"`
	Note       string             `yaml:"note"`
	Caps       map[string]float64 `yaml:"caps"`
	QuoteAbove map[string]float64 `yaml:"quote_above"`
	// UncertainAbove scopes a caveat to the volumes it affects: the plan's
	// price is unambiguous up to these quantities and read one of two ways
	// above them. thirdweb's bands only matter past 100,000 users, so
	// badging its price at 10,000 would demote a figure nobody disputes.
	UncertainAbove map[string]float64 `yaml:"uncertain_above"`
	Tiers          map[string][]Tier  `yaml:"tiers"`
}

type Artifact struct {
	URL        string `yaml:"url"`
	BodySHA256 string `yaml:"body_sha256"`
	VerifiedAt string `yaml:"verified_at"`
	Poll       bool   `yaml:"poll"`
	// PinPhrases keeps sentences that carry a billing rule but no number in
	// the hashed lines (Reown's "custom plan" exclusion).
	PinPhrases []string `yaml:"pin_phrases"`
}

type Provider struct {
	Slug           string           `yaml:"slug"`
	Name           string           `yaml:"name"`
	URL            string           `yaml:"url"`
	Cohort         string           `yaml:"cohort"`
	Unit           string           `yaml:"unit"`
	Note           string           `yaml:"note"`
	ExcludedReason string           `yaml:"excluded_reason"`
	Meters         map[string]Meter `yaml:"meters"`
	// ProfileExclusions names profiles the vendor itself says its
	// self-serve plans are not for, with its words as the reason. Reown sends
	// exchanges and payment platforms to a custom plan; ranking its self-serve
	// price first for a trading app would contradict its own page.
	ProfileExclusions map[string]string   `yaml:"profile_exclusions"`
	Plans             []Plan              `yaml:"plans"`
	Source            map[string]Artifact `yaml:"source"`
}

func LoadCatalogue(path string) (*Catalogue, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseCatalogue(raw)
}

func ParseCatalogue(raw []byte) (*Catalogue, error) {
	var c Catalogue
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	// A misspelt key ("monthy_usd", "quote_abvoe") would otherwise vanish
	// silently and leave the plan free or uncapped.
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	c.SHA256 = hex.EncodeToString(sum[:])
	return &c, nil
}

func (c *Catalogue) validate() error {
	if c.Version < 1 {
		return fmt.Errorf("version missing")
	}
	if _, err := time.Parse("2006-01-02", c.AsOf); err != nil {
		return fmt.Errorf("as_of %q: %w", c.AsOf, err)
	}
	if len(c.Profiles) == 0 || len(c.Volumes) == 0 {
		return fmt.Errorf("profiles and volumes are required")
	}
	seen := map[string]bool{}
	for _, p := range c.Profiles {
		if p.ID == "" || p.Label == "" || seen[p.ID] {
			return fmt.Errorf("profile %q: missing or duplicate id/label", p.ID)
		}
		seen[p.ID] = true
		if p.TxPerUser <= 0 || p.NewUserShare < 0 || p.NewUserShare > 1 {
			return fmt.Errorf("profile %s: tx_per_user must be > 0 and new_user_share in [0,1]", p.ID)
		}
	}
	vseen := map[string]bool{}
	for _, v := range c.Volumes {
		if v.ID == "" || v.MAU <= 0 || vseen[v.ID] {
			return fmt.Errorf("volume %q: missing, non-positive or duplicate", v.ID)
		}
		vseen[v.ID] = true
	}
	if !seen[c.Headline.Profile] || !vseen[c.Headline.Volume] {
		return fmt.Errorf("headline %+v names an unknown profile or volume", c.Headline)
	}
	if c.CurveFloor <= 0 || c.CurveCeiling <= c.CurveFloor {
		return fmt.Errorf("curve range %v..%v is not increasing", c.CurveFloor, c.CurveCeiling)
	}
	for _, v := range c.Volumes {
		// The calculator marks the gauge volumes on its track; one outside
		// the curve would be a button the slider cannot reach.
		if v.MAU < c.CurveFloor || v.MAU > c.CurveCeiling {
			return fmt.Errorf("volume %s (%v) is outside the curve range %v..%v", v.ID, v.MAU, c.CurveFloor, c.CurveCeiling)
		}
	}

	slugs := map[string]bool{}
	ranked := 0
	for i := range c.Providers {
		p := &c.Providers[i]
		if p.Slug == "" || p.Name == "" || slugs[p.Slug] {
			return fmt.Errorf("provider %q: missing or duplicate slug/name", p.Slug)
		}
		slugs[p.Slug] = true
		switch p.Cohort {
		case "excluded":
			if p.ExcludedReason == "" {
				return fmt.Errorf("%s: excluded without a reason", p.Slug)
			}
			if len(p.Plans) > 0 {
				return fmt.Errorf("%s: excluded but carries plans", p.Slug)
			}
			continue
		case "ranked":
			ranked++
		default:
			return fmt.Errorf("%s: cohort %q is neither ranked nor excluded", p.Slug, p.Cohort)
		}
		if err := p.validate(); err != nil {
			return fmt.Errorf("%s: %w", p.Slug, err)
		}
		for id, why := range p.ProfileExclusions {
			if !seen[id] || why == "" {
				return fmt.Errorf("%s: profile exclusion %q names an unknown profile or gives no reason", p.Slug, id)
			}
		}
	}
	if ranked == 0 {
		return fmt.Errorf("no ranked provider")
	}
	return nil
}

func (p *Provider) validate() error {
	if len(p.Meters) == 0 {
		return fmt.Errorf("no meters")
	}
	for name, m := range p.Meters {
		if m.PerUser < 0 || m.PerTx < 0 || m.PerNewWallet < 0 {
			return fmt.Errorf("meter %s: negative coefficient", name)
		}
		if m.PerUser == 0 && m.PerTx == 0 && m.PerNewWallet == 0 {
			return fmt.Errorf("meter %s: all coefficients zero, it would bill nothing", name)
		}
	}
	if len(p.Plans) == 0 {
		return fmt.Errorf("no plans")
	}
	if len(p.Source) == 0 {
		return fmt.Errorf("no source artifact")
	}
	for name, a := range p.Source {
		if a.URL == "" {
			return fmt.Errorf("source %s: no url", name)
		}
		if _, err := time.Parse("2006-01-02", a.VerifiedAt); err != nil {
			return fmt.Errorf("source %s: verified_at %q: %w", name, a.VerifiedAt, err)
		}
		if a.Poll && len(a.BodySHA256) != 64 {
			// Polled with no recorded hash reads ok=1, drift=0 forever: an
			// alarm armed with nothing to compare against.
			return fmt.Errorf("source %s: poll: true needs the 64-hex body_sha256 a human recorded", name)
		}
	}
	ids := map[string]bool{}
	priced := 0
	for _, pl := range p.Plans {
		if pl.ID == "" || pl.Name == "" || ids[pl.ID] {
			return fmt.Errorf("plan %q: missing or duplicate id/name", pl.ID)
		}
		ids[pl.ID] = true
		if pl.Confidence != "verified" && pl.Confidence != "uncertain" {
			return fmt.Errorf("plan %s: confidence %q", pl.ID, pl.Confidence)
		}
		if pl.MonthlyUSD == nil {
			// A quote plan carries nothing else: a cap or tier on it would
			// be a number nobody published.
			if len(pl.Tiers) > 0 || len(pl.Caps) > 0 || len(pl.QuoteAbove) > 0 || pl.Minimum {
				return fmt.Errorf("plan %s: quote (monthly_usd: null) with pricing attached", pl.ID)
			}
			continue
		}
		priced++
		if *pl.MonthlyUSD < 0 || math.IsNaN(*pl.MonthlyUSD) {
			return fmt.Errorf("plan %s: negative fee", pl.ID)
		}
		if pl.Minimum && *pl.MonthlyUSD == 0 {
			return fmt.Errorf("plan %s: a $0 minimum is not a minimum", pl.ID)
		}
		for meter, v := range pl.Caps {
			if _, ok := p.Meters[meter]; !ok {
				return fmt.Errorf("plan %s: cap on undefined meter %s", pl.ID, meter)
			}
			if v <= 0 {
				return fmt.Errorf("plan %s: cap %s must be > 0", pl.ID, meter)
			}
		}
		for meter, v := range pl.QuoteAbove {
			if _, ok := p.Meters[meter]; !ok {
				return fmt.Errorf("plan %s: quote_above on undefined meter %s", pl.ID, meter)
			}
			if v <= 0 {
				return fmt.Errorf("plan %s: quote_above %s must be > 0", pl.ID, meter)
			}
		}
		for meter, v := range pl.UncertainAbove {
			if _, ok := p.Meters[meter]; !ok || v <= 0 {
				return fmt.Errorf("plan %s: uncertain_above on undefined meter %s or not > 0", pl.ID, meter)
			}
			if pl.Confidence != "verified" {
				// A plan already uncertain everywhere gains nothing from a
				// threshold, and the two would disagree about which governs.
				return fmt.Errorf("plan %s: uncertain_above needs confidence: verified below it", pl.ID)
			}
			if pl.Note == "" {
				return fmt.Errorf("plan %s: uncertain_above without a note saying why", pl.ID)
			}
		}
		if pl.Confidence == "uncertain" && pl.Note == "" && p.Note == "" {
			return fmt.Errorf("plan %s: uncertain without a note saying why", pl.ID)
		}
		for meter, tiers := range pl.Tiers {
			if _, ok := p.Meters[meter]; !ok {
				return fmt.Errorf("plan %s: tiers on undefined meter %s", pl.ID, meter)
			}
			if err := validateTiers(tiers); err != nil {
				return fmt.Errorf("plan %s meter %s: %w", pl.ID, meter, err)
			}
		}
		// Every meter the vendor defines must be bounded by this plan one
		// way or another. A meter with no tier, no cap and no quote_above
		// would be served free and without limit, which no vendor sells;
		// it is almost always a forgotten line.
		for meter := range p.Meters {
			_, t := pl.Tiers[meter]
			_, c := pl.Caps[meter]
			_, q := pl.QuoteAbove[meter]
			if !t && !c && !q {
				return fmt.Errorf("plan %s: meter %s is neither priced, capped nor quote-bounded", pl.ID, meter)
			}
		}
	}
	if priced == 0 {
		return fmt.Errorf("no plan with a published price")
	}
	return nil
}

func validateTiers(tiers []Tier) error {
	if len(tiers) == 0 {
		return fmt.Errorf("empty tier list")
	}
	prev := 0.0
	for i, t := range tiers {
		if t.Rate == nil {
			// A tier with no rate is the null-read-as-zero bug: it would
			// serve its whole band free.
			return fmt.Errorf("tier %d: rate missing", i)
		}
		if *t.Rate < 0 || math.IsNaN(*t.Rate) {
			return fmt.Errorf("tier %d: negative rate", i)
		}
		last := i == len(tiers)-1
		if t.UpTo == nil {
			if !last {
				return fmt.Errorf("tier %d: unbounded tier before the last", i)
			}
			continue
		}
		if last {
			// A bounded last tier leaves usage above it unpriced. A plan that
			// stops somewhere says so with `caps` or `quote_above`; the tier
			// list itself always runs to infinity.
			return fmt.Errorf("tier %d: the last tier must be unbounded", i)
		}
		if *t.UpTo <= prev {
			return fmt.Errorf("tier %d: up_to %v not above %v", i, *t.UpTo, prev)
		}
		prev = *t.UpTo
	}
	return nil
}

// Ranked returns the providers that are priced, in catalogue order.
func (c *Catalogue) Ranked() []Provider {
	var out []Provider
	for _, p := range c.Providers {
		if p.Cohort == "ranked" {
			out = append(out, p)
		}
	}
	return out
}

func (c *Catalogue) Profile(id string) (Profile, bool) {
	for _, p := range c.Profiles {
		if p.ID == id {
			return p, true
		}
	}
	return Profile{}, false
}

// sortedKeys gives map iteration a fixed order, so logs, curves and the
// reason chosen for an ineligible provider are reproducible.
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
