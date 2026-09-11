package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

// Meld, aggregator. GET {base}/payments/crypto/quote
// Doc: docs.meld.io (fetched 2026-09-10; the reference page for this
// endpoint returned 404 on the path I tried, and the search summary names
// /payments/virtual-account/quote for the virtual-account flavour). Path
// and auth scheme (BASIC with the API key) are UNVERIFIED against live,
// see CHECKLIST.md. countryCode=FR is a documented parameter:
// country_source="param". One quote per member onramp; each becomes a
// sample with via="meld", cohort="aggregator".

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

// Destination currency codes: Meld qualifies by network in the code
// (UNVERIFIED exact strings).
var meldCrypto = map[string]string{
	"btc/bitcoin": "BTC", "eth/ethereum": "ETH",
	"usdc/base": "USDC_BASE", "usdc/arbitrum": "USDC_ARBITRUM",
}
var meldMethod = map[string]string{"card": "CREDIT_DEBIT_CARD", "sepa": "SEPA"}

type meldQuote struct {
	ServiceProvider   string  `json:"serviceProvider"`
	SourceAmount      float64 `json:"sourceAmount"`
	DestinationAmount float64 `json:"destinationAmount"`
	ExchangeRate      float64 `json:"exchangeRate"`
	TotalFee          float64 `json:"totalFee"`
	NetworkFee        float64 `json:"networkFee"`
	TransactionFee    float64 `json:"transactionFee"`
	PartnerFee        float64 `json:"partnerFee"`
	PaymentMethodType string  `json:"paymentMethodType"`
}

type meldResp struct {
	Quotes []meldQuote `json:"quotes"`
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
	q := url.Values{}
	q.Set("countryCode", PersonaCountry)
	q.Set("sourceCurrencyCode", "EUR")
	q.Set("destinationCurrencyCode", dest)
	q.Set("paymentMethodType", method)
	q.Set("sourceAmount", trimFloat(req.Notional))
	u := m.base() + "/payments/crypto/quote?" + q.Encode()
	auth := "BASIC " + base64.StdEncoding.EncodeToString([]byte(m.key+":"))
	res, err := doJSON(ctx, "GET", u, map[string]string{"Authorization": auth}, nil)
	if err != nil {
		return nil, res.Latency, err
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
			FeeProvider: mq.TransactionFee, FeeNetwork: mq.NetworkFee, FeePartner: mq.PartnerFee,
			ProviderMarketRate: mq.ExchangeRate, RawJSONHash: h,
		})
	}
	if len(out) == 0 {
		return nil, res.Latency, ErrNoQuote
	}
	return out, res.Latency, nil
}

func (m *meldAdapter) CountrySource() string { return "param" }
