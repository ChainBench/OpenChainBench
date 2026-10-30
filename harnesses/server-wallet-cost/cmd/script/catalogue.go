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

// The catalogue is the harness's only input: human-verified prices and the
// workload scenarios. See pricing/catalogue.yml for the model in prose. Loading validates it and FAILS CLOSED: rpc-cost's five
// worst bugs were each a value never stated being read as zero or one, and
// every one of them produced a plausible wrong price rather than an error.

type Catalogue struct {
	Version   int        `yaml:"version"`
	AsOf      string     `yaml:"as_of"`
	Scenarios []Scenario `yaml:"scenarios"`
	Headline  Headline   `yaml:"headline"`
	Providers []Provider `yaml:"providers"`
	// SHA256 of the catalogue file's bytes, carried by the curve and checked
	// by `pnpm validate` and by the harness's site-curve gauge.
	SHA256 string `yaml:"-"`
}

// Scenario is one kind of server or agent workload, priced along its own
// axis x (transactions for a bot, wallets for payouts, agents for agents).
// Wallets active in the month and transactions in the month are affine in x:
//
//	wallets = wallets_fixed + wallets_per_x * x
//	tx      = tx_fixed      + tx_per_x      * x
type Scenario struct {
	ID          string  `yaml:"id" json:"id"`
	Label       string  `yaml:"label" json:"label"`
	Axis        string  `yaml:"axis" json:"axis"`
	WalletsFix  float64 `yaml:"wallets_fixed" json:"walletsFixed"`
	WalletsPerX float64 `yaml:"wallets_per_x" json:"walletsPerX"`
	TxFix       float64 `yaml:"tx_fixed" json:"txFixed"`
	TxPerX      float64 `yaml:"tx_per_x" json:"txPerX"`
	Floor       float64 `yaml:"floor" json:"floor"`
	Ceiling     float64 `yaml:"ceiling" json:"ceiling"`
	Sizes       []Size  `yaml:"sizes" json:"sizes"`
}

type Size struct {
	ID string  `yaml:"id" json:"id"`
	X  float64 `yaml:"x" json:"x"`
}

type Headline struct {
	Scenario string `yaml:"scenario" json:"scenario"`
	Size     string `yaml:"size" json:"size"`
}

// Meter is a billed quantity as a linear function of the month's active
// wallets and transactions.
type Meter struct {
	PerWallet float64 `yaml:"per_wallet"`
	PerTx     float64 `yaml:"per_tx"`
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
	// AnnualUSD is a fee the vendor publishes per year (Dfns). It is written
	// as published, so the drift check can find it on the page, and becomes
	// MonthlyUSD = AnnualUSD / 12 at load. Never both.
	AnnualUSD *float64 `yaml:"annual_usd"`
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
	// Bound says which way the other reading of an uncertain price goes:
	// "upper" when the priced reading is the higher one (the true bill is at
	// most this), "lower" when it is the lower one (at least this). An upper
	// bound that is still the cheapest is the cheapest under both readings,
	// so the calculator may name it; a lower bound may not.
	Bound string            `yaml:"bound"`
	Tiers map[string][]Tier `yaml:"tiers"`
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
	// ScenarioExclusions names scenarios the vendor itself says its
	// self-serve plans are not for, with its words as the reason.
	ScenarioExclusions map[string]string   `yaml:"scenario_exclusions"`
	Plans              []Plan              `yaml:"plans"`
	Source             map[string]Artifact `yaml:"source"`
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
	for i := range c.Providers {
		for j := range c.Providers[i].Plans {
			pl := &c.Providers[i].Plans[j]
			if pl.AnnualUSD == nil {
				continue
			}
			if pl.MonthlyUSD != nil {
				return nil, fmt.Errorf("%s plan %s: monthly_usd and annual_usd both set", c.Providers[i].Slug, pl.ID)
			}
			m := *pl.AnnualUSD / 12
			pl.MonthlyUSD = &m
		}
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
	if len(c.Scenarios) == 0 {
		return fmt.Errorf("scenarios are required")
	}
	seen := map[string]bool{}
	sizeIDs := map[string]bool{}
	for i, s := range c.Scenarios {
		if s.ID == "" || s.Label == "" || s.Axis == "" || seen[s.ID] {
			return fmt.Errorf("scenario %q: missing or duplicate id/label/axis", s.ID)
		}
		seen[s.ID] = true
		if s.WalletsFix < 0 || s.WalletsPerX < 0 || s.TxFix < 0 || s.TxPerX < 0 {
			return fmt.Errorf("scenario %s: negative coefficient", s.ID)
		}
		if s.TxPerX == 0 && s.WalletsPerX == 0 {
			return fmt.Errorf("scenario %s: nothing moves with x", s.ID)
		}
		if s.Floor <= 0 || s.Ceiling <= s.Floor {
			return fmt.Errorf("scenario %s: range %v..%v is not increasing", s.ID, s.Floor, s.Ceiling)
		}
		if len(s.Sizes) == 0 {
			return fmt.Errorf("scenario %s: no sizes", s.ID)
		}
		ids := map[string]bool{}
		for _, z := range s.Sizes {
			if z.ID == "" || ids[z.ID] || z.X < s.Floor || z.X > s.Ceiling {
				return fmt.Errorf("scenario %s size %q: missing, duplicate or outside %v..%v", s.ID, z.ID, s.Floor, s.Ceiling)
			}
			ids[z.ID] = true
		}
		// Every scenario publishes the same size ids, so a size tab means
		// "small / medium / large of whichever scenario you are on".
		if i == 0 {
			sizeIDs = ids
		} else if len(ids) != len(sizeIDs) {
			return fmt.Errorf("scenario %s: size ids differ from the first scenario's", s.ID)
		} else {
			for id := range ids {
				if !sizeIDs[id] {
					return fmt.Errorf("scenario %s: size %s not in the first scenario", s.ID, id)
				}
			}
		}
	}
	if !seen[c.Headline.Scenario] || !sizeIDs[c.Headline.Size] {
		return fmt.Errorf("headline %+v names an unknown scenario or size", c.Headline)
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
		for id, why := range p.ScenarioExclusions {
			if !seen[id] || why == "" {
				return fmt.Errorf("%s: scenario exclusion %q names an unknown scenario or gives no reason", p.Slug, id)
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
		if m.PerWallet < 0 || m.PerTx < 0 {
			return fmt.Errorf("meter %s: negative coefficient", name)
		}
		if m.PerWallet == 0 && m.PerTx == 0 {
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
		switch pl.Bound {
		case "":
		case "upper", "lower":
			if pl.Confidence != "uncertain" && len(pl.UncertainAbove) == 0 {
				return fmt.Errorf("plan %s: bound on a plan with no uncertainty", pl.ID)
			}
		default:
			return fmt.Errorf("plan %s: bound %q is neither upper nor lower", pl.ID, pl.Bound)
		}
		if (pl.Confidence == "uncertain" || len(pl.UncertainAbove) > 0) && pl.Bound == "" {
			// The calculator, the grid and the ledger decide whether a price
			// may lead from its bound; an unbounded one would be read three
			// different ways.
			return fmt.Errorf("plan %s: an uncertain price needs bound: upper or lower", pl.ID)
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

func (c *Catalogue) Scenario(id string) (Scenario, bool) {
	for _, s := range c.Scenarios {
		if s.ID == id {
			return s, true
		}
	}
	return Scenario{}, false
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
