package main

import "context"

// Provider is the chain-aware quote adapter contract. Each adapter declares
// which chains it supports via Supports() so the scheduler can skip the
// (provider, pair) combos that would always fail. Mobula supports the full
// V1 basket; some providers like Bebop don't ship every chain.
//
// Probe MUST set OK=true ONLY when the response was parsed AND a usable
// output amount was extracted. OK=false on any failure where the latency is
// not representative — the adapter is responsible for recording the right
// counter (auth / throttle / no-route / other) before returning.
type Provider interface {
	Slug() string
	Supports(chainId int) bool
	Probe(ctx context.Context, pair TestPair) (Quote, error)
}

// Quote is one probe's result.
//
// Until 2026-10-19 this was a bare (latencyMs, ok, err) and every adapter
// parsed the output amount only to decide ok, then threw it away. Measuring
// how fast an aggregator answers says nothing about what it gives you, which
// is the question readers actually ask, so the amount now comes back.
type Quote struct {
	LatencyMs int64
	OK        bool

	// OutAmount is the output in the destination token's smallest unit,
	// exactly as the provider returned it, as a string because several
	// return values beyond int64 and parsing is the caller's business.
	// Empty when the probe failed.
	OutAmount string

	// FeeBps is the fee the provider itself declares on this quote, and -1
	// when it declares nothing. The distinction matters: an undeclared fee
	// is not the same as no fee, and conflating them would publish the
	// quieter provider as the cheaper one.
	//
	// Measured on 2026-10-19, two of five declare: LI.FI returns a
	// "LIFI Fixed Fee" of 0.0025 marked included, and 0x a zeroExFee of
	// 15.0 bps. Both matched the shortfall observed against the other
	// providers to within 1.3 bps, so the declaration is trustworthy where
	// it exists.
	FeeBps float64

	// OutAlreadyScaled marks an OutAmount that is already in whole tokens
	// rather than the token's smallest unit.
	//
	// Every adapter but one returns smallest units. Mobula's field is
	// `amountOutTokens` and it arrives pre-divided, so scaling it again by
	// the token's decimals published 0.00238 USDT where the others
	// published 2389. The flag is explicit because the difference is
	// invisible on a stablecoin pair until someone reads the axis.
	OutAlreadyScaled bool

	// Block the provider says it quoted against, 0 when it does not say.
	// Three of five report it. It is the only way to prove two quotes saw
	// the same market, which matters because the market drifts 30 to 37 bps
	// over five minutes while providers sit within 25 bps of each other.
	Block uint64

	// GasUnits is the gas the provider estimates its own route will burn,
	// 0 when it does not say. This is a property of the route: a longer
	// path through more pools really does cost more to execute, and on one
	// 0.1 ETH to USDC swap on Base the estimates ranged from ParaSwap's
	// 182,300 to KyberSwap's 715,498, which is a real difference between
	// the two and not noise.
	//
	// Self-reported, and the page says so. Ground truth would be
	// eth_estimateGas against the provider's own calldata, which needs
	// swap-tier credentials we do not hold everywhere.
	GasUnits uint64

	// GasPriceWei is the gas price the provider assumed, 0 when it does not
	// say. Kept apart from GasUnits on purpose: it is a guess about the
	// chain, not about the route. The same three providers above assumed
	// 6,000,000, 7,187,357 and 7,294,509 wei for Base within one minute, so
	// a cost computed with each provider's own price would rank the guesses
	// and reward whoever assumed the cheapest chain. Any normalised cost
	// multiplies everyone's units by one price we read ourselves; this
	// field exists to show the spread, not to be multiplied.
	GasPriceWei float64

	// GasCostOut is the gas cost already expressed in output-token units,
	// for the one provider that does the conversion itself (Route returns
	// gasCostOut and netOut). 0 when absent. Not comparable across
	// providers without knowing which gas price produced it.
	GasCostOut string
}

// failed builds the Quote for a probe that produced no usable amount.
func failed() Quote { return Quote{OK: false, FeeBps: -1} }

// ok builds the Quote for a successful probe that reported no fee and no
// block. Adapters whose API returns either set the fields themselves.
func okQuote(ms int64, outAmount string) Quote {
	return Quote{LatencyMs: ms, OK: true, OutAmount: outAmount, FeeBps: -1}
}
