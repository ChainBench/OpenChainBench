package main

import (
	"context"
	"encoding/json"
	"net/url"
	"time"
)

// MoonPay. GET https://api.moonpay.com/v3/currencies/{code}/buy_quote
// Doc: https://dev.moonpay.com/reference/getbuyquote (fetched 2026-09-10,
// no date on page). Publishable key as `apiKey` query param. There is no
// country parameter on this endpoint; the response carries
// notAllowedCountries per currency. Pricing is therefore whatever the
// vantage receives, and the sample is labelled country_source="ip".
//
// areFeesIncluded=true makes baseCurrencyAmount the total the user pays,
// which is the persona's notional; totalAmount is used as fiat_in.

type moonpayAdapter struct{ pk string }

func (m *moonpayAdapter) Slug() string   { return "moonpay" }
func (m *moonpayAdapter) Cohort() string { return "onramp" }
func (m *moonpayAdapter) Enabled() bool  { return m.pk != "" }

// Currency codes per persona asset and network. usdc_base and usdc_arbitrum
// are MoonPay's documented pattern for network-qualified stablecoins
// (UNVERIFIED for this exact pair, see CHECKLIST.md).
var moonpayCurrency = map[string]string{
	"btc/bitcoin": "btc", "eth/ethereum": "eth",
	"usdc/base": "usdc_base", "usdc/arbitrum": "usdc_arbitrum",
}

// Payment method enum values as listed in the widget design guide
// (dev.moonpay.com/widget/on-ramp/design-guide). sepa_bank_transfer is
// documented; credit_debit_card is the documented card value.
var moonpayMethod = map[string]string{"card": "credit_debit_card", "sepa": "sepa_bank_transfer"}

type moonpayResp struct {
	QuoteCurrencyAmount float64 `json:"quoteCurrencyAmount"`
	QuoteCurrencyPrice  float64 `json:"quoteCurrencyPrice"`
	BaseCurrencyAmount  float64 `json:"baseCurrencyAmount"`
	FeeAmount           float64 `json:"feeAmount"`
	ExtraFeeAmount      float64 `json:"extraFeeAmount"`
	NetworkFeeAmount    float64 `json:"networkFeeAmount"`
	TotalAmount         float64 `json:"totalAmount"`
	ExpiresIn           float64 `json:"expiresIn"`
	Message             string  `json:"message"`
	Type                string  `json:"type"`
}

func (m *moonpayAdapter) Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error) {
	code, ok := moonpayCurrency[req.Asset.Asset+"/"+req.Network]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	method, ok := moonpayMethod[req.PaymentMethod]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	q := url.Values{}
	q.Set("apiKey", m.pk)
	q.Set("baseCurrencyCode", "eur")
	q.Set("baseCurrencyAmount", trimFloat(req.Notional))
	q.Set("paymentMethod", method)
	q.Set("areFeesIncluded", "true")
	u := baseFor("moonpay", "https://api.moonpay.com") + "/v3/currencies/" + code + "/buy_quote?" + q.Encode()
	res, err := doJSON(ctx, "GET", u, nil, nil)
	if err != nil {
		return nil, res.Latency, err
	}
	if res.Status != 200 {
		return nil, res.Latency, statusErr("moonpay", res)
	}
	var r moonpayResp
	if err := json.Unmarshal(res.Body, &r); err != nil {
		return nil, res.Latency, err
	}
	if r.QuoteCurrencyAmount <= 0 {
		return nil, res.Latency, ErrNoQuote
	}
	fiatIn := r.TotalAmount
	if fiatIn <= 0 {
		fiatIn = r.BaseCurrencyAmount
	}
	return []NormalizedQuote{{
		Provider: "moonpay", Cohort: "onramp", Via: "direct", Asset: req.Asset.Asset, Network: req.Network,
		PaymentMethod: req.PaymentMethod, Notional: req.Notional, CountrySource: "ip",
		FiatIn: fiatIn, CryptoOut: r.QuoteCurrencyAmount,
		FeeProvider: r.FeeAmount, FeeNetwork: r.NetworkFeeAmount, FeePartner: r.ExtraFeeAmount,
		ProviderMarketRate: r.QuoteCurrencyPrice, TTLSeconds: r.ExpiresIn,
		RawJSONHash: hashBody(res.Body),
	}}, res.Latency, nil
}

func truncate(b []byte) string {
	if len(b) > 160 {
		return string(b[:160]) + "…"
	}
	return string(b)
}

func (m *moonpayAdapter) CountrySource() string { return "ip" }
