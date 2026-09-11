package main

import (
	"context"
	"errors"
	"time"
)

// QuoteRequest is one cell of the persona grid.
type QuoteRequest struct {
	Asset         AssetSpec
	Network       string // the network actually requested (primary or fallback)
	PaymentMethod string // card, sepa
	Notional      float64
}

// Adapter is the one interface every provider implements. Quote returns
// one or more normalized quotes: exactly one for a direct provider, one
// per member ramp for an aggregator. ErrNoQuote means the provider
// answered without a usable quote for this cell.
type Adapter interface {
	Slug() string
	Cohort() string // "onramp" or "aggregator"
	Enabled() bool  // false when its key is unset: skipped, never failed
	// CountrySource says how the persona country reaches the provider:
	// "param" when the API takes a country, "ip" when it geolocates.
	CountrySource() string
	Quote(ctx context.Context, req QuoteRequest) ([]NormalizedQuote, time.Duration, error)
}

// buildAdapters wires every provider that has a key. Order is stable so
// logs are readable.
func buildAdapters(cfg *Config) []Adapter {
	return []Adapter{
		&moonpayAdapter{pk: cfg.MoonPayPK},
		&transakAdapter{key: cfg.TransakAPIKey, staging: cfg.TransakStaging},
		&rampAdapter{hostKey: cfg.RampHostAPIKey},
		&mercuryoAdapter{widgetID: cfg.MercuryoWidgetID},
		&onramperAdapter{key: cfg.OnramperAPIKey},
		&meldAdapter{key: cfg.MeldAPIKey, sandbox: cfg.MeldSandbox},
	}
}

// classifyErr maps an adapter error to the errors_total reason label.
func classifyErr(err error) string {
	var se *httpStatusError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrNoQuote):
		return "no_quote"
	case errors.As(err, &se) && se.Status >= 500:
		return "http_5xx"
	case errors.As(err, &se) && se.Status == 429:
		return "rate_limited"
	case errors.As(err, &se):
		return "http_4xx"
	case isTimeout(err):
		return "timeout"
	case errors.Is(err, ErrRetryable):
		return "network"
	default:
		return "parse"
	}
}
