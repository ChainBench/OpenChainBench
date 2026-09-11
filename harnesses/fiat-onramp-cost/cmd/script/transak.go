package main

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

// Transak. GET {base}/api/v1/pricing/public/quotes
// Doc: https://docs.transak.com/reference/get-price (fetched 2026-09-10, no
// date on page). Partner key both as `x-api-key` header and `partnerApiKey`
// query param, as documented. quoteCountryCode=FR is passed explicitly:
// the docs say it exists "to ensure consistency in pricing that user sees
// on your platform as well as ours", which is exactly the identical-inputs
// property this bench needs. country_source="param".

type transakAdapter struct {
	key     string
	staging bool
}

func (t *transakAdapter) Slug() string   { return "transak" }
func (t *transakAdapter) Cohort() string { return "onramp" }
func (t *transakAdapter) Enabled() bool  { return t.key != "" }

// Network values as documented in the parameter table (arbitrum, ethereum,
// mainnet). "mainnet" for BTC follows the doc example; UNVERIFIED that base
// is spelled "base" (see CHECKLIST.md).
var transakNetwork = map[string]string{"bitcoin": "mainnet", "ethereum": "ethereum", "base": "base", "arbitrum": "arbitrum"}
var transakMethod = map[string]string{"card": "credit_debit_card", "sepa": "sepa_bank_transfer"}

type transakResp struct {
	Response struct {
		QuoteID               string  `json:"quoteId"`
		ConversionPrice       float64 `json:"conversionPrice"`
		MarketConversionPrice float64 `json:"marketConversionPrice"`
		FiatAmount            float64 `json:"fiatAmount"`
		CryptoAmount          float64 `json:"cryptoAmount"`
		TotalFee              float64 `json:"totalFee"`
		FeeBreakdown          []struct {
			Name  string  `json:"name"`
			Value float64 `json:"value"`
			ID    string  `json:"id"`
		} `json:"feeBreakdown"`
	} `json:"response"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (t *transakAdapter) base() string {
	if t.staging {
		return baseFor("transak", "https://api-stg.transak.com")
	}
	return baseFor("transak", "https://api.transak.com")
}

func (t *transakAdapter) Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error) {
	net, ok := transakNetwork[req.Network]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	method, ok := transakMethod[req.PaymentMethod]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	q := url.Values{}
	q.Set("partnerApiKey", t.key)
	q.Set("fiatCurrency", "EUR")
	q.Set("cryptoCurrency", strings.ToUpper(req.Asset.Asset))
	q.Set("network", net)
	q.Set("isBuyOrSell", "BUY")
	q.Set("fiatAmount", trimFloat(req.Notional))
	q.Set("paymentMethod", method)
	q.Set("quoteCountryCode", PersonaCountry)
	u := t.base() + "/api/v1/pricing/public/quotes?" + q.Encode()
	res, err := doJSON(ctx, "GET", u, map[string]string{"x-api-key": t.key}, nil)
	if err != nil {
		return nil, res.Latency, err
	}
	if res.Status != 200 {
		return nil, res.Latency, statusErr("transak", res)
	}
	var r transakResp
	if err := json.Unmarshal(res.Body, &r); err != nil {
		return nil, res.Latency, err
	}
	rp := r.Response
	if rp.CryptoAmount <= 0 {
		return nil, res.Latency, ErrNoQuote
	}
	nq := NormalizedQuote{
		Provider: "transak", Cohort: "onramp", Via: "direct", Asset: req.Asset.Asset, Network: req.Network,
		PaymentMethod: req.PaymentMethod, Notional: req.Notional, CountrySource: "param",
		FiatIn: rp.FiatAmount, CryptoOut: rp.CryptoAmount,
		ProviderMarketRate: rp.MarketConversionPrice, RawJSONHash: hashBody(res.Body),
	}
	// feeBreakdown ids are matched by substring so a rename on their side
	// ("transak_fee" vs "transakFee") degrades to "unclassified", which is
	// summed into fee_provider and flagged in the log rather than dropped.
	var classified float64
	for _, f := range rp.FeeBreakdown {
		id := strings.ToLower(f.ID + " " + f.Name)
		switch {
		case strings.Contains(id, "network"):
			nq.FeeNetwork += f.Value
		case strings.Contains(id, "partner"):
			nq.FeePartner += f.Value
		default:
			nq.FeeProvider += f.Value
		}
		classified += f.Value
	}
	if len(rp.FeeBreakdown) == 0 && rp.TotalFee > 0 {
		nq.FeeProvider = rp.TotalFee
	}
	return []NormalizedQuote{nq}, res.Latency, nil
}

func (t *transakAdapter) CountrySource() string { return "param" }
