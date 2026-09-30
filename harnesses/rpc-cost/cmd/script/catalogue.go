package main

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// The pricing catalogue is the harness's input of record. It is a
// committed, human-reviewed file rather than a live scrape, because RPC
// pricing is prose on a marketing page for most of the cohort and a
// parser that guesses is worse than a parser that does not exist. What
// IS live is the freshness check in refresh.go: every figure carries the
// artifact it came from, the harness re-fetches those artifacts on a
// loop, and the bench publishes how stale each provider's numbers are.
//
// Note what that check is and is not: the age is PUBLISHED, per provider
// per artifact, as rpc_pricing_artifact_age_seconds. Nothing in this
// harness compares it to a threshold, so there is no cutoff past which a
// figure is withheld or relabelled. A stale number is visible as stale
// because its age is on the board next to it, which is what the spec
// claims ("Age is published either way"), and nothing more.

type Catalogue struct {
	Version   int        `yaml:"version"`
	AsOf      string     `yaml:"as_of"`
	FX        FX         `yaml:"fx"`
	Providers []Provider `yaml:"providers"`
}

type FX struct {
	EURUSD float64 `yaml:"eur_usd"`
	Source string  `yaml:"source"`
	Date   string  `yaml:"date"`
}

type Provider struct {
	Slug            string              `yaml:"slug"`
	Name            string              `yaml:"name"`
	Cohort          string              `yaml:"cohort"` // usage | dedicated | excluded
	// Ranked false marks a reference row: a real, usable endpoint that is
	// not a purchasable product and must never be called the winner.
	// PublicNode and the chain foundations' public RPCs are $0 with no
	// SLA and, in PublicNode's case, no published rate limit at all — so
	// "cheapest" would be both true and useless. They are emitted under
	// cohort="reference" so the leaderboard can show them without ranking
	// them. Absent means ranked.
	Ranked          *bool               `yaml:"ranked"`
	Status          string              `yaml:"status"` // live | end-of-life | dead | no-price-published
	ExclusionReason string              `yaml:"exclusion_reason"`
	Unit            string              `yaml:"unit"`
	PricingModel    string              `yaml:"pricing_model"` // per_method | per_chain | flat_request | depth_based
	Currency        string              `yaml:"currency"`
	Plans           []Plan              `yaml:"plans"`
	Weights         map[string]Weights  `yaml:"weights"` // chain -> method weights
	// ArchiveWeights is a full second table for providers whose archive
	// cost is an independent lookup rather than a multiple of the
	// standard cost. GetBlock is the case that forced it: its API returns
	// full_cu and archive_cu per method, and the ratio is 2x on the
	// catch-all reads and 3x on the enumerated debug, trace and txpool
	// methods, so no single multiplier is correct.
	// When present it replaces Weights entirely for archive workloads.
	ArchiveWeights map[string]Weights `yaml:"archive_weights"`
	// ThroughputWeights is a SECOND, different unit table used only for the
	// rate limit. Alchemy meters volume in Compute Units and throughput in
	// Throughput Compute Units, and the two disagree by up to 25x on the
	// same method (debug_traceTransaction: 40 billing, 1000 throughput), so
	// checking a rate limit against billing units understates it badly.
	// The published table is partial, and a partial table cannot produce an
	// honest weighted average: when a profile uses a method the table does
	// not price, the throughput check is skipped and said to be skipped,
	// rather than quietly falling back to the wrong unit.
	ThroughputWeights map[string]Weights `yaml:"throughput_weights"`
	ArchiveRule    ArchiveRule        `yaml:"archive_rule"`
	Source          map[string]Artifact `yaml:"source"` // "plans" | "weights"
	Caveats         []string            `yaml:"caveats"`
}

// Weights carries a per-method unit cost plus the catch-all every
// provider in this cohort publishes. `Default` is what an unlisted
// method costs, which for Infura (80 credits) and dRPC (20 CU) is the
// entire table.
// Pointers, not plain floats, because null and 0 mean opposite things
// here. A YAML null unmarshals into a float64 as 0, which would turn
// "this provider does not serve debug_traceTransaction" into "it serves
// it for free" — and a free heavy method wins a cost leaderboard
// outright. Meanwhile a genuine 0 is real: dRPC charges nothing for
// eth_chainId and the Solana *Unsubscribe calls. Only a pointer tells
// the two apart.
type Weights struct {
	Default *float64            `yaml:"default"`
	Methods map[string]*float64 `yaml:",inline"`
}

// Weight returns the units charged for one call of `method`, falling
// back to the chain default. The second return is false when the
// provider publishes no price for the method — which the caller must
// treat as "cannot be priced", never as zero.
func (w Weights) Weight(method string) (float64, bool) {
	if v, ok := w.Methods[method]; ok {
		if v == nil {
			return 0, false // explicitly unpriced or unsupported
		}
		return *v, true
	}
	if w.Default != nil {
		return *w.Default, true
	}
	return 0, false
}

type Plan struct {
	ID           string     `yaml:"id"`
	Name         string     `yaml:"name"`
	// Tier buckets plans across providers so "the cheapest entry plan" is
	// answerable: free | entry | growth | business | enterprise. Derived
	// from the monthly price when absent (see PlanTier), because provider
	// plan names are marketing and do not line up — Chainstack "Growth"
	// is $49 while Helius "Business" is $499.
	Tier          string    `yaml:"tier"`
	MonthlyUSD    *float64  `yaml:"monthly_usd"`
	AnnualMonthly *float64  `yaml:"annual_monthly_usd"`
	// PackagePriceUSD is the sticker price of a plan sold as an expiring
	// package rather than a monthly subscription — BlockPI's $49/60d and
	// $299/90d. It is pro-rated onto a 30-day month by AllowancePeriod.
	// Kept separate from MonthlyUSD so the page can show the real thing
	// the provider sells ("$299 for 90 days") next to the pro-rated
	// figure the leaderboard has to use to compare it with a subscription.
	PackagePriceUSD *float64 `yaml:"package_price_usd"`
	IncludedUnits   *float64 `yaml:"included_units"`
	// month | day | package_32d | package_60d | package_90d | lifetime.
	// The period is load-bearing: Infura's cap is daily and does not roll
	// over, BlockPI sells packages that expire, and treating either as a
	// monthly pool overstates what the plan actually buys.
	AllowancePeriod string   `yaml:"allowance_period"`
	OveragePer1M    *float64 `yaml:"overage_per_1m_units_usd"`
	// OverageBands expresses a sliding rate that gets cheaper with volume
	// (Validation Cloud, thirdweb). Without it the model charges the first
	// band's rate at every volume, which overstates a banded provider's
	// bill by 30%+ at the top bucket. Bands are marginal: each band's rate
	// applies only to the units falling inside it.
	OverageBands []OverageBand `yaml:"overage_bands"`
	// MaxUnits is a hard ceiling the plan cannot serve past even with
	// overage. Distinct from IncludedUnits: beyond IncludedUnits you pay
	// more, beyond MaxUnits the plan is simply not an option.
	MaxUnits *float64 `yaml:"max_units"`
	// true | false | hard_stop. hard_stop means the plan stops serving at
	// the cap rather than billing extra, so it is ineligible above it
	// instead of merely expensive.
	OverageAllowed string `yaml:"overage_allowed"`
	// RequiresPlan names a plan on the same provider that must be held
	// before this one can be bought. Its price is added to the bill.
	// Infura's $200 extra-credits add-on cannot be bought on the free
	// tier, so the real entry cost is Developer $50 + $200 = $250 — which
	// is what makes it lose to Team's $225 without anyone having to
	// adjudicate its ambiguous allowance period. Helius's dedicated nodes
	// require the $499 Business plan the same way.
	RequiresPlan string `yaml:"requires_plan"`
	// Chains this plan actually serves. Required on unmetered capacity:
	// that path skips unitsPerRequest, which is where every other cohort's
	// chain check lives, so without it an Ethereum-only node leads the
	// Solana tab at an Ethereum price and a Solana node carries an
	// Ethereum bill. Empty means "the weights table decides", which is
	// correct for per-request plans and wrong for a dedicated node.
	Chains []string `yaml:"chains"`
	Throughput     Throughput `yaml:"throughput"`
	Archive        string     `yaml:"archive"` // true | false | gated
	Trace          *bool      `yaml:"trace"`
	Confidence     string     `yaml:"confidence"` // verified | uncertain | unpublished
	Note           string     `yaml:"note"`
}

type Throughput struct {
	Unit  string   `yaml:"unit"` // rps | cu_per_s | credits_per_s
	Value *float64 `yaml:"value"`
}

// OverageBand is one step of a sliding rate. UpToUnits is the cumulative
// ceiling of the band, counted from zero; the last band should carry a
// null ceiling meaning "everything above".
type OverageBand struct {
	UpToUnits  *float64 `yaml:"up_to_units"`
	PricePer1M float64  `yaml:"price_per_1m_usd"`
}

type ArchiveRule struct {
	Kind  string  `yaml:"kind"` // multiplier | additive | block_age | none
	Value float64 `yaml:"value"`
	Note  string  `yaml:"note"`
}

type Artifact struct {
	URL        string `yaml:"url"`
	Kind       string `yaml:"kind"` // json | markdown | html
	Poll       string `yaml:"poll"` // etag | body_hash | manual
	Extraction string `yaml:"extraction"`
	// BodySHA256 is the hash of the artifact as it read when a human last
	// verified the numbers below it. refresh.go compares against it and
	// raises rpc_pricing_artifact_drift when the upstream moves, which is
	// the signal that the catalogue needs a human pass.
	BodySHA256 string `yaml:"body_sha256"`
	VerifiedAt string `yaml:"verified_at"`
}

func LoadCatalogue(path string) (*Catalogue, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read catalogue: %w", err)
	}
	var c Catalogue
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse catalogue: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// validate fails closed on the mistakes that would silently corrupt a
// ranking: a EUR provider with no FX rate, a plan priced in neither
// monthly nor overage terms, and a usage-cohort provider with no weights.
func (c *Catalogue) validate() error {
	seen := map[string]bool{}
	for _, p := range c.Providers {
		if p.Slug == "" {
			return fmt.Errorf("provider with empty slug")
		}
		if seen[p.Slug] {
			return fmt.Errorf("duplicate provider slug %q", p.Slug)
		}
		seen[p.Slug] = true

		if p.Cohort == "excluded" {
			if p.ExclusionReason == "" {
				return fmt.Errorf("%s: excluded providers must carry an exclusion_reason", p.Slug)
			}
			continue
		}
		if p.Currency == "EUR" && c.FX.EURUSD <= 0 {
			return fmt.Errorf("%s: priced in EUR but catalogue carries no fx.eur_usd", p.Slug)
		}
		if p.Cohort == "usage" && len(p.Weights) == 0 {
			return fmt.Errorf("%s: usage cohort requires a weights table (use default: 1 for flat-request providers)", p.Slug)
		}
		for _, pl := range p.Plans {
			// A sales-gated plan legitimately has no price — 25 of them in
			// the cohort, and "Enterprise, contact us" is itself a finding.
			// It must be declared unpublished rather than merely empty, so
			// that a plan whose price we simply failed to record still
			// fails the load instead of quietly ranking as free.
			//
			// The check is on the BASE price specifically. An earlier
			// version accepted any plan carrying an overage rate, which
			// let BlockPI's $299/90d package load with a null base and be
			// scored as if the package were free — a $99.67/mo error that
			// moved it up the dapp leaderboard. A missing base price must
			// be either an explicit 0 or an explicit "unpublished".
			if pl.MonthlyUSD == nil && pl.PackagePriceUSD == nil && pl.Confidence != "unpublished" {
				return fmt.Errorf("%s/%s: no monthly_usd and no package_price_usd; write 0 if the plan genuinely has no base fee, or confidence: unpublished if the price is sales-gated", p.Slug, pl.ID)
			}
			if pl.PackagePriceUSD != nil && !strings.HasPrefix(pl.AllowancePeriod, "package_") {
				return fmt.Errorf("%s/%s: package_price_usd needs an allowance_period of package_<n>d to pro-rate against", p.Slug, pl.ID)
			}
			switch pl.OverageAllowed {
			case "true", "false", "hard_stop", "":
			default:
				return fmt.Errorf("%s/%s: bad overage_allowed %q", p.Slug, pl.ID, pl.OverageAllowed)
			}
		}

		if p.Cohort == "dedicated" {
			for _, pl := range p.Plans {
				if pl.Confidence == "unpublished" {
					continue
				}
				if len(pl.Chains) == 0 {
					return fmt.Errorf("%s/%s: dedicated capacity must declare `chains:`; without it the plan prices every chain tab, including ones it does not serve", p.Slug, pl.ID)
				}
			}
		}

		// A zero or missing archive multiplier silently zeroes every
		// archive workload's unit cost, which made GetBlock the cheapest
		// indexer and trace provider in the cohort at $0 per month.
		// Providers whose archive price is an independent lookup rather
		// than a multiple must publish an archive_weights table.
		if p.ArchiveRule.Kind == "multiplier" && p.ArchiveRule.Value <= 0 && len(p.ArchiveWeights) == 0 {
			return fmt.Errorf("%s: archive_rule.kind is multiplier but value is %v; set a positive multiplier, or supply archive_weights if the archive cost is an independent table, or use kind: none", p.Slug, p.ArchiveRule.Value)
		}
	}
	return nil
}

// isReference reports whether the provider is published but never ranked.
func (p Provider) isReference() bool { return p.Ranked != nil && !*p.Ranked }

// Plan tiers. Provider plan names do not line up across the cohort —
// Chainstack "Growth" is $49 and Helius "Business" is $499 — so a reader
// asking "which entry plan is cheapest" cannot be answered by name. The
// tier is a price band, stated rather than inferred.
const (
	TierFree       = "free"
	TierEntry      = "entry"      // paid, up to $50/mo
	TierGrowth     = "growth"     // $50 to $300/mo
	TierBusiness   = "business"   // $300 to $1000/mo
	TierEnterprise = "enterprise" // above $1000/mo, or sales-gated
)

// PlanTier returns the plan's declared tier, falling back to its price
// band. An explicit `tier:` in the catalogue always wins, because a few
// plans sit oddly against their price (a $0 trial that is not a free
// tier, a sales-gated plan with a published floor).
func (c *Catalogue) PlanTier(p Provider, pl Plan) string {
	if pl.Tier != "" {
		return pl.Tier
	}
	if pl.MonthlyUSD == nil {
		return TierEnterprise
	}
	switch usd := c.toUSD(*pl.MonthlyUSD, p.Currency); {
	case usd == 0:
		return TierFree
	case usd <= 50:
		return TierEntry
	case usd <= 300:
		return TierGrowth
	case usd <= 1000:
		return TierBusiness
	default:
		return TierEnterprise
	}
}

// FreeAllowanceRequests converts a free plan's unit allowance into the
// number of requests of a given profile it actually buys. This is the
// only honest way to rank free tiers against each other: they all cost
// $0, so the question is what you get, and "200M credits" means nothing
// until you know a credit buys 1/200th of a request.
func (c *Catalogue) FreeAllowanceRequests(p Provider, pr Profile) (float64, string, bool) {
	for _, pl := range p.Plans {
		if c.PlanTier(p, pl) != TierFree || pl.IncludedUnits == nil {
			continue
		}
		// An allowance the plan cannot spend on this workload is not an
		// allowance. dRPC's free tier led the trace panel at 10.5M requests
		// while its own plan is archive: false, trace: false and the ledger
		// on the same page refused it: the panel contradicted the table.
		if pr.Archive && pl.Archive == "false" {
			continue
		}
		if isTraceProfile(pr) && pl.Trace != nil && !*pl.Trace {
			continue
		}
		if len(pl.Chains) > 0 && !servesChain(pl, pr.Chain) {
			continue
		}
		upr, err := unitsPerRequest(p, pr)
		if err != nil || upr <= 0 {
			continue
		}
		units := *pl.IncludedUnits * periodScale(pl.AllowancePeriod)
		if pl.AllowancePeriod == "day" {
			units = *pl.IncludedUnits * daysPerMonth
		}
		return units / upr, pl.ID, true
	}
	return 0, "", false
}

// toUSD converts a catalogue figure into USD. Only NOWNodes prices in
// EUR today; the rate lives in the catalogue header so the conversion is
// visible on the page rather than baked into a number.
func (c *Catalogue) toUSD(v float64, currency string) float64 {
	if currency == "EUR" {
		return v * c.FX.EURUSD
	}
	return v
}
