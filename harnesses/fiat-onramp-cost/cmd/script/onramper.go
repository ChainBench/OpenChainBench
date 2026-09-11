package main

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

// Onramper, aggregator. GET https://api.onramper.com/quotes/{fiat}/{crypto}
// Doc: https://docs.onramper.com/reference/get_quotes-fiat-crypto, page
// last updated 2026-07-28. `Authorization: <api key>` header. country=fr is
// passed explicitly ("auto-determined by IP if absent"): country_source=
// "param". One call returns one object per member ramp; each becomes a
// sample with provider=<member slug>, via="onramper", cohort="aggregator".
// The spec never ranks these against the direct cohort.

type onramperAdapter struct{ key string }

func (o *onramperAdapter) Slug() string   { return "onramper" }
func (o *onramperAdapter) Cohort() string { return "aggregator" }
func (o *onramperAdapter) Enabled() bool  { return o.key != "" }

// Crypto ids: Onramper qualifies stablecoins by network with an underscore
// (UNVERIFIED exact ids, see CHECKLIST.md). btc and eth are unqualified.
var onramperCrypto = map[string]string{
	"btc/bitcoin": "btc", "eth/ethereum": "eth",
	"usdc/base": "usdc_base", "usdc/arbitrum": "usdc_arbitrum",
}

// paymentMethod values: "creditcard" is the documented example; the SEPA
// id is UNVERIFIED and taken from Onramper's payment-types listing
// convention.
var onramperMethod = map[string]string{"card": "creditcard", "sepa": "sepabanktransfer"}

type onramperQuote struct {
	Ramp           string  `json:"ramp"`
	PaymentMethod  string  `json:"paymentMethod"`
	Rate           float64 `json:"rate"`
	Payout         float64 `json:"payout"`
	NetworkFee     float64 `json:"networkFee"`
	TransactionFee float64 `json:"transactionFee"`
	QuoteID        string  `json:"quoteId"`
	Errors         []struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"errors"`
}

// Member ramp names as Onramper reports them, mapped to OCB product slugs
// so the same provider is one product across cohorts.
var onramperRampSlug = map[string]string{
	"moonpay": "moonpay", "transak": "transak", "ramp": "ramp", "mercuryo": "mercuryo",
	"banxa": "banxa", "alchemypay": "alchemypay", "unlimit": "unlimit", "guardarian": "guardarian",
	"topper": "topper", "coinbase": "coinbase", "paybis": "paybis", "sardine": "sardine",
	"simplex": "simplex", "wert": "wert", "meld": "meld",
}

func (o *onramperAdapter) Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error) {
	crypto, ok := onramperCrypto[req.Asset.Asset+"/"+req.Network]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	method, ok := onramperMethod[req.PaymentMethod]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	q := url.Values{}
	q.Set("amount", trimFloat(req.Notional))
	q.Set("paymentMethod", method)
	q.Set("country", strings.ToLower(PersonaCountry))
	q.Set("type", "buy")
	u := baseFor("onramper", "https://api.onramper.com") + "/quotes/eur/" + crypto + "?" + q.Encode()
	res, err := doJSON(ctx, "GET", u, map[string]string{"Authorization": o.key}, nil)
	if err != nil {
		return nil, res.Latency, err
	}
	if res.Status != 200 {
		return nil, res.Latency, statusErr("onramper", res)
	}
	var arr []onramperQuote
	if err := json.Unmarshal(res.Body, &arr); err != nil {
		return nil, res.Latency, err
	}
	h := hashBody(res.Body)
	var out []NormalizedQuote
	for _, m := range arr {
		if m.Payout <= 0 || len(m.Errors) > 0 {
			continue
		}
		slug := onramperRampSlug[strings.ToLower(m.Ramp)]
		if slug == "" {
			slug = strings.ToLower(m.Ramp)
		}
		out = append(out, NormalizedQuote{
			Provider: slug, Via: "onramper", Cohort: "aggregator",
			Asset: req.Asset.Asset, Network: req.Network, PaymentMethod: req.PaymentMethod,
			Notional: req.Notional, CountrySource: "param",
			FiatIn: req.Notional, CryptoOut: m.Payout,
			FeeProvider: m.TransactionFee, FeeNetwork: m.NetworkFee,
			ProviderMarketRate: m.Rate, RawJSONHash: h,
		})
	}
	if len(out) == 0 {
		return nil, res.Latency, ErrNoQuote
	}
	return out, res.Latency, nil
}

func (o *onramperAdapter) CountrySource() string { return "param" }
