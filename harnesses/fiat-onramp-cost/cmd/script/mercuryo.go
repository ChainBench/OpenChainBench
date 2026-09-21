package main

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Mercuryo. GET https://api.mercuryo.io/v1.6/widget/buy/rate
// Doc: github.com/mercuryoio/api-migration-docs, Widget_API_Mercuryo_v1.6.md
// (fetched 2026-09-10, no date on page). widget_id identifies the partner.
// v1.6 "responses now contain information about commission". Shape
// VERIFIED live 2026-09-14 (testdata/mercuryo_rate.json is a real
// response): every money field is a {crypto, fiat} pair keyed by
// currency code, e.g. "fee": {"BTC": "0.00013906", "EUR": "9.59"}, and
// fee = mercuryo_fee + network_fee. "partner_fee" is null for a widget
// without a partner markup. No country parameter: country_source="ip".

type mercuryoAdapter struct{ widgetID string }

func (m *mercuryoAdapter) Slug() string   { return "mercuryo" }
func (m *mercuryoAdapter) Cohort() string { return "onramp" }
func (m *mercuryoAdapter) Enabled() bool  { return m.widgetID != "" }

var mercuryoNetwork = map[string]string{"bitcoin": "BITCOIN", "ethereum": "ETHEREUM", "base": "BASE", "arbitrum": "ARBITRUM"}

// mercuryoMoney is a {"BTC": "0.001", "EUR": "9.59"} pair; only the
// fiat leg is used. Null (partner_fee) decodes to an empty map.
type mercuryoMoney map[string]json.Number

func (m mercuryoMoney) eur() float64 {
	v, _ := strconv.ParseFloat(string(m["EUR"]), 64)
	return v
}

type mercuryoResp struct {
	Status int `json:"status"`
	Data   struct {
		Amount      json.Number   `json:"amount"`       // crypto out
		Rate        json.Number   `json:"rate"`         // fiat per unit
		Fee         mercuryoMoney `json:"fee"`          // total fee = mercuryo_fee + network_fee
		MercuryoFee mercuryoMoney `json:"mercuryo_fee"` // provider share
		NetworkFee  mercuryoMoney `json:"network_fee"`  // chain fee
		PartnerFee  mercuryoMoney `json:"partner_fee"`  // widget owner markup, null here
		FiatAmount  json.Number   `json:"fiat_amount"`  // total fiat
	} `json:"data"`
	Message string `json:"message"`
}

func (m *mercuryoAdapter) Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error) {
	net, ok := mercuryoNetwork[req.Network]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	// The widget rate endpoint has no payment-method parameter in the
	// documented sample; the same quote is recorded for card only, and
	// sepa is reported as no_quote so the cell stays honest.
	if req.PaymentMethod != "card" {
		return nil, 0, ErrNoQuote
	}
	q := url.Values{}
	q.Set("from", "EUR")
	q.Set("to", strings.ToUpper(req.Asset.Asset))
	q.Set("amount", trimFloat(req.Notional))
	q.Set("network", net)
	q.Set("widget_id", m.widgetID)
	u := baseFor("mercuryo", "https://api.mercuryo.io") + "/v1.6/widget/buy/rate?" + q.Encode()
	res, err := doJSON(ctx, "GET", u, nil, nil)
	if err != nil {
		return nil, res.Latency, err
	}
	if res.Status != 200 {
		return nil, res.Latency, statusErr("mercuryo", res)
	}
	var r mercuryoResp
	if err := json.Unmarshal(res.Body, &r); err != nil {
		return nil, res.Latency, err
	}
	out, _ := strconv.ParseFloat(string(r.Data.Amount), 64)
	if out <= 0 {
		return nil, res.Latency, ErrNoQuote
	}
	rate, _ := strconv.ParseFloat(string(r.Data.Rate), 64)
	fiatIn, _ := strconv.ParseFloat(string(r.Data.FiatAmount), 64)
	if fiatIn <= 0 {
		fiatIn = req.Notional
	}
	// Split the fee the way the other adapters do. When the breakdown is
	// absent, the total goes to the provider column.
	feeProvider := r.Data.MercuryoFee.eur()
	feeNetwork := r.Data.NetworkFee.eur()
	if feeProvider == 0 && feeNetwork == 0 {
		feeProvider = r.Data.Fee.eur()
	}
	return []NormalizedQuote{{
		Provider: "mercuryo", Cohort: "onramp", Via: "direct", Asset: req.Asset.Asset, Network: req.Network,
		PaymentMethod: req.PaymentMethod, Notional: req.Notional, CountrySource: "ip",
		FiatIn: fiatIn, CryptoOut: out, FeeProvider: feeProvider, FeeNetwork: feeNetwork,
		FeePartner: r.Data.PartnerFee.eur(), ProviderMarketRate: rate,
		RawJSONHash: hashBody(res.Body),
	}}, res.Latency, nil
}

func (m *mercuryoAdapter) CountrySource() string { return "ip" }
