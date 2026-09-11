package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
)

// NormalizedQuote is the one shape every adapter produces. Amounts are in
// the persona's units: fiat in EUR, crypto in whole units of the asset
// (BTC, not satoshi; ETH, not wei; USDC, not micro-USDC). Adapters that
// receive base units convert here, never downstream.
type NormalizedQuote struct {
	Provider      string  // product slug, matches /products/<slug>
	Via           string  // "" for a direct quote, "onramper" or "meld" for an aggregator sub-quote
	Cohort        string  // "onramp" or "aggregator"
	Asset         string  // btc, usdc, eth
	Network       string  // bitcoin, base, arbitrum, ethereum
	PaymentMethod string  // card, sepa
	Notional      float64 // requested fiat amount, EUR
	CountrySource string  // "param" when the API took country=FR, "ip" when it geolocated the vantage

	FiatIn             float64 // total fiat the user pays, fees included
	CryptoOut          float64 // whole units delivered
	FeeProvider        float64 // EUR
	FeeNetwork         float64 // EUR
	FeePartner         float64 // EUR
	ProviderMarketRate float64 // EUR per unit as the provider reports it, 0 when absent
	TTLSeconds         float64 // 0 when the provider returns none
	MinFiat            float64 // 0 when absent
	MaxFiat            float64 // 0 when absent
	RawJSONHash        string  // sha256 of the response body, for reproduction
}

// ErrNoQuote is what an adapter returns when the provider answered but the
// answer carries no usable quote for the persona (unsupported method,
// notional below minimum, asset not listed). Counted as a miss, never as
// a zero.
var ErrNoQuote = errors.New("no usable quote")

// Basis-point maths. Kept in one file so a reviewer can check the three
// formulas against the spec in one screen.

// AllInPremiumBps is the effective price the user paid per unit, relative
// to a spot reference, in basis points. Worked example from the issue:
// 500 EUR buys 0.0048 BTC at spot 100 000 → effective price 104 166.67 →
// (104 166.67 − 100 000) / 100 000 × 1e4 = 416.67 bps.
func AllInPremiumBps(fiatIn, cryptoOut, spot float64) (float64, error) {
	if fiatIn <= 0 || cryptoOut <= 0 || spot <= 0 {
		return 0, errors.New("all-in premium needs positive fiat, crypto and spot")
	}
	effective := fiatIn / cryptoOut
	return (effective - spot) / spot * 1e4, nil
}

// DeclaredFeeBps is what the provider says it charges, all fee fields
// summed, as a share of the fiat the user pays.
func DeclaredFeeBps(q NormalizedQuote) (float64, error) {
	if q.FiatIn <= 0 {
		return 0, errors.New("declared fee needs positive fiat_in")
	}
	return (q.FeeProvider + q.FeeNetwork + q.FeePartner) / q.FiatIn * 1e4, nil
}

// HiddenSpreadBps is the part of the premium the provider does not call a
// fee: the markup embedded in its exchange rate. Can be negative when the
// provider's rate beats the reference mid, which happens on illiquid
// moments and is reported as is.
func HiddenSpreadBps(allIn, declared float64) float64 {
	return allIn - declared
}

// FromBaseUnits converts an integer-string amount in the asset's smallest
// unit into whole units. Ramp returns wei for ETH and satoshi for BTC.
func FromBaseUnits(raw float64, decimals int) float64 {
	return raw / math.Pow10(decimals)
}

// AssetDecimals is the on-chain precision per persona asset.
func AssetDecimals(asset string) int {
	switch asset {
	case "btc":
		return 8
	case "eth":
		return 18
	case "usdc":
		return 6
	}
	return 0
}

func hashBody(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// trimFloat renders a notional as a label: 100 → "100", 500 → "500",
// matching the string amount labels the bridge-fee bench uses.
func trimFloat(f float64) string {
	if f == math.Trunc(f) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprintf("%g", f)
}
