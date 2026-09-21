package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"
)

// Ramp Network. POST https://api.ramp.network/api/host-api/v3/onramp/quote/all
// Doc: https://docs.rampnetwork.com/rest-api-v3-reference (fetched
// 2026-09-10, no date on page). hostApiKey as query param, obtained from
// partner@ramp.network. One request returns a quote per payment method, so
// a cell maps to one key of the response; crypto amounts come back in
// base units (wei, satoshi, micro-USDC) and are converted with the asset's
// decimals from the same response. userCountryCode=FR is passed:
// country_source="param".
//
// Rate limits are documented at docs.rampnetwork.com/rate-limiting: 100
// requests / minute and 1000 / 15 minutes per source IP, a one-hour block
// on exceeding the latter. One cycle issues at most 6 Ramp calls (one per
// asset × notional; both methods come from one call).

type rampAdapter struct{ hostKey string }

func (r *rampAdapter) Slug() string   { return "ramp" }
func (r *rampAdapter) Cohort() string { return "onramp" }
func (r *rampAdapter) Enabled() bool  { return r.hostKey != "" }

// Asset symbols follow Ramp's CHAIN_TOKEN convention (UNVERIFIED for the
// exact strings, see CHECKLIST.md).
var rampSymbol = map[string]string{
	"btc/bitcoin": "BTC_BTC", "eth/ethereum": "ETH_ETH",
	"usdc/base": "BASE_USDC", "usdc/arbitrum": "ARBITRUM_USDC",
}

// Payment method keys as documented in the PaymentMethodName enum.
var rampMethod = map[string]string{"card": "CARD_PAYMENT", "sepa": "MANUAL_BANK_TRANSFER"}

type rampMethodQuote struct {
	CryptoAmount string  `json:"cryptoAmount"` // base units, decimal string
	FiatValue    float64 `json:"fiatValue"`
	AppliedFee   float64 `json:"appliedFee"`
	BaseRampFee  float64 `json:"baseRampFee"`
}

type rampResp struct {
	Asset struct {
		Symbol   string             `json:"symbol"`
		Decimals int                `json:"decimals"`
		Price    map[string]float64 `json:"price"`
	} `json:"asset"`
	Quotes map[string]rampMethodQuote `json:"-"`
}

// parseRamp reads the per-method keys off the top level of the object,
// alongside the `asset` block, without hardcoding every method name.
func parseRamp(body []byte) (rampResp, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return rampResp{}, err
	}
	var r rampResp
	r.Quotes = map[string]rampMethodQuote{}
	if a, ok := top["asset"]; ok {
		if err := json.Unmarshal(a, &r.Asset); err != nil {
			return r, err
		}
	}
	for k, v := range top {
		if k == "asset" {
			continue
		}
		var q rampMethodQuote
		if json.Unmarshal(v, &q) == nil && q.CryptoAmount != "" {
			r.Quotes[k] = q
		}
	}
	return r, nil
}

func (r *rampAdapter) Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error) {
	sym, ok := rampSymbol[req.Asset.Asset+"/"+req.Network]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	mkey, ok := rampMethod[req.PaymentMethod]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	body, _ := json.Marshal(map[string]any{
		"cryptoAssetSymbol": sym, "fiatCurrency": "EUR", "fiatValue": req.Notional,
		"userCountryCode": PersonaCountry,
	})
	u := baseFor("ramp", "https://api.ramp.network") + "/api/host-api/v3/onramp/quote/all?hostApiKey=" + r.hostKey
	res, err := doJSON(ctx, "POST", u, nil, body)
	if err != nil {
		return nil, res.Latency, err
	}
	if res.Status != 200 && res.Status != 201 {
		return nil, res.Latency, statusErr("ramp", res)
	}
	parsed, err := parseRamp(res.Body)
	if err != nil {
		return nil, res.Latency, err
	}
	mq, ok := parsed.Quotes[mkey]
	if !ok {
		return nil, res.Latency, ErrNoQuote
	}
	raw, err := strconv.ParseFloat(mq.CryptoAmount, 64)
	if err != nil || raw <= 0 {
		return nil, res.Latency, ErrNoQuote
	}
	dec := parsed.Asset.Decimals
	if dec == 0 {
		dec = AssetDecimals(req.Asset.Asset)
	}
	return []NormalizedQuote{{
		Provider: "ramp", Cohort: "onramp", Via: "direct", Asset: req.Asset.Asset, Network: req.Network,
		PaymentMethod: req.PaymentMethod, Notional: req.Notional, CountrySource: "param",
		FiatIn: mq.FiatValue, CryptoOut: FromBaseUnits(raw, dec),
		FeeProvider: mq.AppliedFee, ProviderMarketRate: parsed.Asset.Price["EUR"],
		RawJSONHash: hashBody(res.Body),
	}}, res.Latency, nil
}

func (r *rampAdapter) CountrySource() string { return "param" }
