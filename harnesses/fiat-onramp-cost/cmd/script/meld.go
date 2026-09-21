package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// Meld, aggregator. POST {base}/payments/crypto/quote with a JSON body.
// Verified live against api-sb.meld.io on 2026-09-16 (see CHECKLIST.md):
//   - Authorization: BASIC base64(<api key>). The key from the dashboard is
//     already "<id>:<secret>"; appending ":" before encoding gives 403, and
//     GET gives 405 (POST only).
//   - Meld-Version: 2025-03-04 pins the response shape.
//   - Body: countryCode, sourceCurrencyCode, sourceAmount (number),
//     destinationCurrencyCode (network-qualified: BTC, ETH, USDC_BASE),
//     paymentMethodType (CREDIT_DEBIT_CARD, SEPA).
//   - Response: {quotes:[{serviceProvider, sourceAmount, destinationAmount,
//     exchangeRate, totalFee, networkFee, transactionFee, partnerFee|null,
//     paymentMethodType, ...}]}; errors are {code, message} with a 4xx
//     (INVALID_AMOUNT_TOO_HIGH, QUOTE_TIMEOUT on 408).
// countryCode=FR is a body parameter: country_source="param". One quote per
// member onramp; each becomes a sample with via="meld", cohort="aggregator".
// Sandbox keys work only on api-sb.meld.io and return synthetic rates (BTC
// quoted 37% above spot on 2026-09-16), so MELD_SANDBOX=true is for wiring
// tests, never for published numbers.

type meldAdapter struct {
	key     string
	sandbox bool
}

func (m *meldAdapter) Slug() string   { return "meld" }
func (m *meldAdapter) Cohort() string { return "aggregator" }
func (m *meldAdapter) Enabled() bool  { return m.key != "" }

func (m *meldAdapter) base() string {
	if m.sandbox {
		return baseFor("meld", "https://api-sb.meld.io")
	}
	return baseFor("meld", "https://api.meld.io")
}

// Destination currency codes: Meld qualifies by network in the code.
var meldCrypto = map[string]string{
	"btc/bitcoin": "BTC", "eth/ethereum": "ETH",
	"usdc/base": "USDC_BASE", "usdc/arbitrum": "USDC_ARBITRUM",
}
var meldMethod = map[string]string{"card": "CREDIT_DEBIT_CARD", "sepa": "SEPA"}

type meldQuote struct {
	ServiceProvider   string   `json:"serviceProvider"`
	SourceAmount      float64  `json:"sourceAmount"`
	DestinationAmount float64  `json:"destinationAmount"`
	ExchangeRate      float64  `json:"exchangeRate"`
	TotalFee          float64  `json:"totalFee"`
	NetworkFee        float64  `json:"networkFee"`
	TransactionFee    float64  `json:"transactionFee"`
	PartnerFee        *float64 `json:"partnerFee"` // null when the partner adds no markup
	PaymentMethodType string   `json:"paymentMethodType"`
}

type meldResp struct {
	Quotes  []meldQuote `json:"quotes"`
	Code    string      `json:"code"`    // set on error bodies
	Message string      `json:"message"` // set on error bodies
}

type meldReq struct {
	CountryCode             string  `json:"countryCode"`
	SourceCurrencyCode      string  `json:"sourceCurrencyCode"`
	SourceAmount            float64 `json:"sourceAmount"`
	DestinationCurrencyCode string  `json:"destinationCurrencyCode"`
	PaymentMethodType       string  `json:"paymentMethodType"`
}

var meldProviderSlug = map[string]string{
	"MOONPAY": "moonpay", "TRANSAK": "transak", "RAMP": "ramp", "MERCURYO": "mercuryo",
	"BANXA": "banxa", "PAYBIS": "paybis", "UNLIMIT": "unlimit", "TOPPER": "topper",
	"COINBASE": "coinbase", "MESO": "meso", "STRIPE": "stripe", "BLOCKCHAINDOTCOM": "blockchain-com",
	"ROBINHOOD": "robinhood-connect", "ALCHEMYPAY": "alchemypay", "GUARDARIAN": "guardarian",
}

func (m *meldAdapter) Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error) {
	dest, ok := meldCrypto[req.Asset.Asset+"/"+req.Network]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	method, ok := meldMethod[req.PaymentMethod]
	if !ok {
		return nil, 0, ErrNoQuote
	}
	body, _ := json.Marshal(meldReq{
		CountryCode: PersonaCountry, SourceCurrencyCode: "EUR", SourceAmount: req.Notional,
		DestinationCurrencyCode: dest, PaymentMethodType: method,
	})
	u := m.base() + "/payments/crypto/quote"
	auth := "BASIC " + base64.StdEncoding.EncodeToString([]byte(m.key))
	res, err := doJSON(ctx, "POST", u, map[string]string{"Authorization": auth, "Meld-Version": "2025-03-04"}, body)
	if err != nil {
		return nil, res.Latency, err
	}
	if res.Status == 400 || res.Status == 404 {
		// INVALID_AMOUNT_TOO_HIGH, no provider for the cell, unsupported
		// currency: a cell the aggregator cannot serve, not an outage.
		return nil, res.Latency, ErrNoQuote
	}
	if res.Status != 200 {
		return nil, res.Latency, statusErr("meld", res)
	}
	var r meldResp
	if err := json.Unmarshal(res.Body, &r); err != nil {
		// Some Meld endpoints return the array at top level.
		var arr []meldQuote
		if err2 := json.Unmarshal(res.Body, &arr); err2 != nil {
			return nil, res.Latency, err
		}
		r.Quotes = arr
	}
	h := hashBody(res.Body)
	var out []NormalizedQuote
	for _, mq := range r.Quotes {
		if mq.DestinationAmount <= 0 {
			continue
		}
		slug := meldProviderSlug[strings.ToUpper(mq.ServiceProvider)]
		if slug == "" {
			slug = strings.ToLower(mq.ServiceProvider)
		}
		fiatIn := mq.SourceAmount
		if fiatIn <= 0 {
			fiatIn = req.Notional
		}
		out = append(out, NormalizedQuote{
			Provider: slug, Via: "meld", Cohort: "aggregator",
			Asset: req.Asset.Asset, Network: req.Network, PaymentMethod: req.PaymentMethod,
			Notional: req.Notional, CountrySource: "param",
			FiatIn: fiatIn, CryptoOut: mq.DestinationAmount,
			FeeProvider: mq.TransactionFee, FeeNetwork: mq.NetworkFee, FeePartner: derefFloat(mq.PartnerFee),
			ProviderMarketRate: mq.ExchangeRate, RawJSONHash: h,
		})
	}
	if len(out) == 0 {
		return nil, res.Latency, ErrNoQuote
	}
	return out, res.Latency, nil
}

func (m *meldAdapter) CountrySource() string { return "param" }

func derefFloat(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
