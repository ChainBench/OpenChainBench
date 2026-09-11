package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Every adapter is exercised against a fixture that mirrors its documented
// response shape, through the real HTTP path (headers, params, retry).
// The fixtures are documented shapes, not live captures: see CHECKLIST.md
// for which fields are verified against live.

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func serve(t *testing.T, slug string, check func(r *http.Request), body []byte, status int) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if check != nil {
			check(r)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	endpointOverride[slug] = srv.URL
	t.Cleanup(func() { delete(endpointOverride, slug) })
}

var btcSepa500 = QuoteRequest{Asset: AssetSpec{Asset: "btc", Network: "bitcoin"}, Network: "bitcoin", PaymentMethod: "sepa", Notional: 500}

func TestMoonPayAdapter(t *testing.T) {
	serve(t, "moonpay", func(r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v3/currencies/btc/buy_quote") {
			t.Errorf("path %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("apiKey") != "pk_test_x" || q.Get("baseCurrencyAmount") != "500" || q.Get("paymentMethod") != "sepa_bank_transfer" || q.Get("areFeesIncluded") != "true" {
			t.Errorf("params %v", q)
		}
	}, fixture(t, "moonpay_buy_quote.json"), 200)
	a := &moonpayAdapter{pk: "pk_test_x"}
	qs, _, err := a.Quote(context.Background(), btcSepa500)
	if err != nil {
		t.Fatal(err)
	}
	q := qs[0]
	if q.Provider != "moonpay" || q.Via != "direct" || q.Cohort != "onramp" || q.CountrySource != "ip" {
		t.Errorf("identity %+v", q)
	}
	if q.FiatIn != 500 || q.CryptoOut != 0.00744 || q.TTLSeconds != 60 {
		t.Errorf("amounts %+v", q)
	}
	d, _ := DeclaredFeeBps(q)
	if !near(d, (19.62+0.38)/500*1e4, 0.01) {
		t.Errorf("declared %v", d)
	}
}

func TestMoonPay4xxIsNotRetriedAndClassified(t *testing.T) {
	hits := 0
	serve(t, "moonpay", func(*http.Request) { hits++ }, []byte(`{"message":"bad","type":"BadRequestError"}`), 400)
	a := &moonpayAdapter{pk: "pk"}
	_, _, err := a.Quote(context.Background(), btcSepa500)
	if err == nil || hits != 1 {
		t.Fatalf("err=%v hits=%d", err, hits)
	}
	if classifyErr(err) != "http_4xx" {
		t.Errorf("reason %s", classifyErr(err))
	}
}

func TestMoonPay5xxRetriedOnce(t *testing.T) {
	hits := 0
	serve(t, "moonpay", func(*http.Request) { hits++ }, []byte(`{}`), 503)
	a := &moonpayAdapter{pk: "pk"}
	_, _, err := a.Quote(context.Background(), btcSepa500)
	if err == nil || hits != 2 {
		t.Fatalf("err=%v hits=%d", err, hits)
	}
	if classifyErr(err) != "http_5xx" {
		t.Errorf("reason %s", classifyErr(err))
	}
}

func TestTransakAdapter(t *testing.T) {
	serve(t, "transak", func(r *http.Request) {
		if r.URL.Path != "/api/v1/pricing/public/quotes" {
			t.Errorf("path %s", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "k1" {
			t.Errorf("header missing")
		}
		q := r.URL.Query()
		if q.Get("partnerApiKey") != "k1" || q.Get("quoteCountryCode") != "FR" || q.Get("fiatAmount") != "500" || q.Get("cryptoCurrency") != "BTC" || q.Get("isBuyOrSell") != "BUY" {
			t.Errorf("params %v", q)
		}
	}, fixture(t, "transak_quote.json"), 200)
	a := &transakAdapter{key: "k1"}
	qs, _, err := a.Quote(context.Background(), btcSepa500)
	if err != nil {
		t.Fatal(err)
	}
	q := qs[0]
	if q.CryptoOut != 0.00738 || q.FiatIn != 500 || q.CountrySource != "param" {
		t.Errorf("%+v", q)
	}
	if q.FeeProvider != 4.9 || q.FeeNetwork != 1 {
		t.Errorf("fee split provider=%v network=%v", q.FeeProvider, q.FeeNetwork)
	}
}

func TestRampAdapter(t *testing.T) {
	serve(t, "ramp", func(r *http.Request) {
		if r.Method != "POST" || !strings.HasPrefix(r.URL.Path, "/api/host-api/v3/onramp/quote/all") || r.URL.Query().Get("hostApiKey") != "hk" {
			t.Errorf("%s %s", r.Method, r.URL)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["cryptoAssetSymbol"] != "BTC_BTC" || body["fiatCurrency"] != "EUR" || body["fiatValue"] != float64(500) || body["userCountryCode"] != "FR" {
			t.Errorf("body %v", body)
		}
	}, fixture(t, "ramp_quote_all.json"), 200)
	a := &rampAdapter{hostKey: "hk"}
	qs, _, err := a.Quote(context.Background(), btcSepa500)
	if err != nil {
		t.Fatal(err)
	}
	q := qs[0]
	if !near(q.CryptoOut, 0.0076, 1e-12) {
		t.Errorf("base units not converted: %v", q.CryptoOut)
	}
	if q.FeeProvider != 9.9 || q.ProviderMarketRate != 64480.5 {
		t.Errorf("%+v", q)
	}
	card := btcSepa500
	card.PaymentMethod = "card"
	qs, _, _ = a.Quote(context.Background(), card)
	if !near(qs[0].CryptoOut, 0.00744, 1e-12) {
		t.Errorf("card cell %v", qs[0].CryptoOut)
	}
}

func TestMercuryoAdapter(t *testing.T) {
	serve(t, "mercuryo", func(r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/v1.6/widget/buy/rate" || q.Get("from") != "EUR" || q.Get("to") != "BTC" || q.Get("amount") != "500" || q.Get("widget_id") != "w" || q.Get("network") != "BITCOIN" {
			t.Errorf("%s", r.URL)
		}
	}, fixture(t, "mercuryo_rate.json"), 200)
	a := &mercuryoAdapter{widgetID: "w"}
	card := btcSepa500
	card.PaymentMethod = "card"
	qs, _, err := a.Quote(context.Background(), card)
	if err != nil {
		t.Fatal(err)
	}
	if qs[0].CryptoOut != 0.00741 || qs[0].FeeProvider != 20.5 || qs[0].FiatIn != 500 {
		t.Errorf("%+v", qs[0])
	}
	// sepa is not a documented parameter: honest no_quote, no HTTP call.
	if _, _, err := a.Quote(context.Background(), btcSepa500); err != ErrNoQuote {
		t.Errorf("sepa should be no_quote, got %v", err)
	}
}

func TestOnramperAdapterFansOutPerRamp(t *testing.T) {
	serve(t, "onramper", func(r *http.Request) {
		if r.URL.Path != "/quotes/eur/btc" || r.Header.Get("Authorization") != "pk_prod_x" || r.URL.Query().Get("country") != "fr" {
			t.Errorf("%s auth=%q", r.URL, r.Header.Get("Authorization"))
		}
	}, fixture(t, "onramper_quotes.json"), 200)
	a := &onramperAdapter{key: "pk_prod_x"}
	qs, _, err := a.Quote(context.Background(), btcSepa500)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 2 {
		t.Fatalf("want 2 usable member quotes (banxa errored), got %d", len(qs))
	}
	for _, q := range qs {
		if q.Via != "onramper" || q.Cohort != "aggregator" || q.CountrySource != "param" {
			t.Errorf("%+v", q)
		}
	}
	if qs[0].Provider != "moonpay" || qs[0].CryptoOut != 0.00741 || qs[1].Provider != "transak" {
		t.Errorf("%+v", qs)
	}
}

func TestMeldAdapter(t *testing.T) {
	serve(t, "meld", func(r *http.Request) {
		q := r.URL.Query()
		if !strings.HasPrefix(r.Header.Get("Authorization"), "BASIC ") || q.Get("countryCode") != "FR" || q.Get("sourceCurrencyCode") != "EUR" || q.Get("destinationCurrencyCode") != "BTC" || q.Get("sourceAmount") != "500" {
			t.Errorf("%s", r.URL)
		}
	}, fixture(t, "meld_quote.json"), 200)
	a := &meldAdapter{key: "mk"}
	qs, _, err := a.Quote(context.Background(), btcSepa500)
	if err != nil {
		t.Fatal(err)
	}
	if len(qs) != 2 || qs[0].Provider != "moonpay" || qs[1].Provider != "paybis" || qs[0].Via != "meld" {
		t.Errorf("%+v", qs)
	}
}

func TestDisabledAdaptersAreSkippedNotFailed(t *testing.T) {
	cfg := &Config{ProviderSemaphore: 1, Assets: DefaultAssets, Notionals: DefaultNotionals, PaymentMethods: DefaultPaymentMethods}
	for _, a := range buildAdapters(cfg) {
		if a.Enabled() {
			t.Errorf("%s enabled with empty config", a.Slug())
		}
	}
}

// One full cycle end to end: spot from a stub, one direct provider and one
// aggregator from fixtures, check the gauges and the purge on the next
// cycle when a member ramp disappears.
func TestRunCycleEmitsAndPurges(t *testing.T) {
	serve(t, "moonpay", nil, fixture(t, "moonpay_buy_quote.json"), 200)
	serve(t, "onramper", nil, fixture(t, "onramper_quotes.json"), 200)
	serve(t, "kraken", nil, []byte(krakenFixture), 200)
	serve(t, "pyth", nil, []byte(`{"parsed":[]}`), 200)
	cfg := &Config{ProviderSemaphore: 2, Assets: []AssetSpec{{Asset: "btc", Network: "bitcoin"}}, Notionals: []float64{500}, PaymentMethods: []string{"sepa"}}
	adapters := []Adapter{&moonpayAdapter{pk: "pk"}, &onramperAdapter{key: "k"}}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	seen := runCycle(ctx, cfg, adapters, nil)
	// 1 direct + 2 members + the aggregator's own success cell
	if len(seen) != 4 {
		t.Fatalf("seen %d cells: %v", len(seen), seen)
	}
	l := labelsFor(NormalizedQuote{Provider: "transak", Cohort: "aggregator", Via: "onramper", Asset: "btc", Network: "bitcoin", PaymentMethod: "sepa", Notional: 500, CountrySource: "param"})
	if v := gaugeValue(t, quoteSuccess.With(l)); v != 1 {
		t.Errorf("transak via onramper success %v", v)
	}
	// Next cycle: onramper drops transak.
	serve(t, "onramper", nil, []byte(`[{"ramp":"moonpay","rate":64750.2,"payout":0.00741,"networkFee":0.4,"transactionFee":19.5}]`), 200)
	seen = runCycle(ctx, cfg, adapters, seen)
	if v := gaugeValue(t, quoteSuccess.With(l)); v != 0 {
		t.Errorf("dropped member should be success=0, got %v", v)
	}
	if v := gaugeValue(t, cryptoOut.With(l)); v != 0 {
		t.Errorf("dropped member crypto_out should be purged, got %v", v)
	}
}
