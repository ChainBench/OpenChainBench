package main

import "sort"

// Workload profiles.
//
// The single most robust finding of the pricing audit behind this bench
// is that there is no "cheapest RPC provider" — the winner changes with
// the method mix, and it changes by multiples, not percent. Alchemy is
// half QuickNode's price on eth_blockNumber and three times its price on
// eth_getLogs. Chainstack charges one flat unit for every method, which
// makes it uncompetitive on trivial reads and the cheapest option by an
// order of magnitude on debug_traceTransaction.
//
// So the bench publishes a cost per workload, never a single number. The
// mixes below are deliberately boring and defensible: each one is a
// shape a real product has, not a synthetic benchmark designed to make
// any provider look good.

type Profile struct {
	ID      string
	Label   string
	Chain   string // ethereum | solana
	Archive bool   // whether the calls read state old enough to bill as archive
	Mix     map[string]float64
}

var Profiles = []Profile{
	{
		ID:    "simple-read",
		Label: "Simple reads",
		Chain: "ethereum",
		// The floor case, and the one every provider's marketing implies.
		// One method, no archive, no writes: the cheapest any provider can
		// possibly be, which makes it the honest baseline for "from $X".
		Mix: map[string]float64{"eth_getBalance": 1.0},
	},
	{
		ID:    "dapp",
		Label: "Dapp frontend",
		Chain: "ethereum",
		// A wallet or dapp UI: mostly contract reads and balances, a few
		// receipts as transactions confirm, a thin tail of writes.
		Mix: map[string]float64{
			"eth_call":                  0.40,
			"eth_getBalance":            0.15,
			"eth_blockNumber":           0.15,
			"eth_getTransactionReceipt": 0.15,
			"eth_estimateGas":           0.05,
			"eth_sendRawTransaction":    0.05,
			"eth_getLogs":               0.05,
		},
	},
	{
		ID:      "indexer",
		Label:   "Log indexer",
		Chain:   "ethereum",
		Archive: true,
		// Backfilling an index: getLogs over historical ranges plus the
		// blocks and receipts to resolve them. Archive depth is the point —
		// this is where Chainstack's 2x block-age rule and BlockPI's +30%
		// archive mode actually bite.
		Mix: map[string]float64{
			"eth_getLogs":          0.50,
			"eth_getBlockByNumber": 0.25,
			"eth_getBlockReceipts": 0.25,
		},
	},
	{
		ID:      "trace",
		Label:   "Trace and debug",
		Chain:   "ethereum",
		Archive: true,
		// The most expensive thing you can ask an RPC for, and the mix
		// where per-method pricing diverges hardest from flat pricing.
		Mix: map[string]float64{
			"debug_traceTransaction": 0.60,
			"trace_block":            0.20,
			"eth_getBlockByNumber":   0.20,
		},
	},
	{
		ID:    "solana-bot",
		Label: "Solana trading bot",
		Chain: "solana",
		// Account reads to build state, blockhash to sign, then send and
		// simulate. Solana is priced differently from EVM by most of the
		// cohort (QuickNode 1.5x, Ankr 2.5x, GetBlock 2.5x), so it needs
		// its own column rather than a footnote.
		Mix: map[string]float64{
			"getAccountInfo":      0.40,
			"getMultipleAccounts": 0.20,
			"getLatestBlockhash":  0.15,
			"sendTransaction":     0.15,
			"simulateTransaction": 0.10,
		},
	},
}

// MixOrder returns this profile's methods in a fixed order.
//
// Summing a weighted mix by ranging over the map adds the same terms in a
// different order on every call, and floating-point addition is not
// associative, so the model did not return the same number twice: the
// Solana allowance for Alchemy came back differing in its last bits from
// one call to the next. Nothing on the page showed it, the figures are
// rounded several digits before display, but FreeEnvelopes computes a
// span in a separate pass from the figures it brackets, and a floor a
// hair above the number it was derived from is a table contradicting
// itself. A pricing model that cannot be checked against its own output
// is worth less than the ordering costs.
func (pr Profile) MixOrder() []string {
	methods := make([]string, 0, len(pr.Mix))
	for m := range pr.Mix {
		methods = append(methods, m)
	}
	sort.Strings(methods)
	return methods
}

// Volume buckets, in requests per month. Chosen to straddle the points
// where plan tiers and break-even against a dedicated node actually
// change the answer.
var Buckets = []struct {
	ID       string
	Requests float64
}{
	{"10m", 10e6},
	{"100m", 100e6},
	{"1000m", 1000e6},
}

// PlanTiers is the plan-band axis; every tab other than `all` answers
// "which provider is cheapest if I am shopping at this budget level".
// `all` is the value the bench's queries pin and the site replaces it
// when a reader picks a tab, so it has to carry the default view: the
// cheapest PAID plan. Including free tiers there would
// hand the leaderboard to the $0 rows at the smallest volume and hide the
// comparison readers came for; the `free` tab answers that question on
// its own axis (rpc_free_allowance_requests), where it belongs.
var PlanTiers = []string{"all", "free", "entry", "growth", "business", "enterprise"}

// The slice the site's unfiltered view shows: a dapp method mix at ten
// million requests a month, the entry-scale case most readers arrive
// with. Bigger volumes are a tab away.
const (
	headlineKind   = "dapp"
	headlineBucket = "10m"
)

// baselineProfile returns the profile used as a chain's reference workload
// when pricing a break-even: the first profile declared for that chain.
// Ethereum's is simple-read, Solana's is solana-bot, because that is the
// only Solana workload defined. Without a per-chain baseline the floor was
// computed on an Ethereum profile and every Solana node was dropped for
// want of a denominator.
func baselineProfile(chain string) string {
	for _, pr := range Profiles {
		if pr.Chain == chain {
			return pr.ID
		}
	}
	return ""
}

const daysPerMonth = 30 // stated, not assumed: every derived figure uses it
