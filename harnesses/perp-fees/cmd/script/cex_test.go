package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"testing"
)

func TestApplyCEXQuote(t *testing.T) {
	wantTiers := map[string]float64{
		"1000":    5,
		"10000":   8.999100089990861,
		"100000":  9.899901000989075,
		"1000000": 9.989990010010388,
	}
	tests := []struct {
		name string
		book string
		unit float64
	}{
		{
			name: "base units as strings",
			book: `{"bids":[["1999","10"],["1998","5"]],"asks":[["2001","1"],["2002","1000"]]}`,
			unit: 1,
		},
		{
			name: "contracts as numbers",
			book: `{"bids":[[1999,1000]],"asks":[[2001,100],[2002,100000]]}`,
			unit: 0.01,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var raw pairBook
			if err := json.Unmarshal([]byte(tc.book), &raw); err != nil {
				t.Fatal(err)
			}
			bid, asks, err := bookFromPairs(raw.Bids, raw.Asks, tc.unit)
			if err != nil {
				t.Fatal(err)
			}
			var s PerpSample
			q := cexQuote{takerBps: 6, bestBid: bid, asks: asks}
			if err := applyCEXQuote(&s, q, 1000); err != nil {
				t.Fatal(err)
			}
			if !near(s.SpreadBps, 5) || !near(s.AllInBps, 11) {
				t.Errorf("spread=%v all_in=%v, want 5 and 11", s.SpreadBps, s.AllInBps)
			}
			if len(s.Tiers) != len(wantTiers) {
				t.Fatalf("tiers=%d skipped=%v, want %d",
					len(s.Tiers), s.SkippedTiers, len(wantTiers))
			}
			for _, tier := range s.Tiers {
				want := wantTiers[tier.Notional]
				if !near(tier.SpreadBps, want) || !near(tier.AllInBps, want+6) {
					t.Errorf("tier %s: spread=%v all_in=%v, want %v and %v",
						tier.Notional, tier.SpreadBps, tier.AllInBps, want, want+6)
				}
			}
		})
	}
}

func TestApplyCEXQuote_RejectsBadBook(t *testing.T) {
	tests := []struct {
		name string
		q    cexQuote
	}{
		{name: "no asks", q: cexQuote{bestBid: 100}},
		{name: "no bid", q: cexQuote{asks: []bookLevel{{Px: 100, Sz: 100}}}},
		{name: "crossed", q: cexQuote{bestBid: 101, asks: []bookLevel{{Px: 100, Sz: 100}}}},
		{name: "too thin", q: cexQuote{bestBid: 99, asks: []bookLevel{{Px: 100, Sz: 1}}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var s PerpSample
			if err := applyCEXQuote(&s, tc.q, 1000); err == nil {
				t.Fatalf("got all_in=%v, want an error", s.AllInBps)
			}
			if s.AllInBps != 0 || len(s.Tiers) != 0 {
				t.Errorf("sample filled on a rejected book: %+v", s)
			}
		})
	}
}

func TestBookFromPairs_Rejects(t *testing.T) {
	bids := [][]flexFloat{{99, 1}}
	asks := [][]flexFloat{{100, 1}, {101, 1}}
	shortRow := [][]flexFloat{{100}}
	asksDown := [][]flexFloat{{101, 1}, {100, 1}}
	bidsUp := [][]flexFloat{{98, 1}, {99, 1}}
	tests := []struct {
		name string
		bids [][]flexFloat
		asks [][]flexFloat
		unit float64
		want error
	}{
		{name: "no bids", asks: asks, unit: 1, want: errEmptyOrderbook},
		{name: "no contract size", bids: bids, asks: asks, want: errNoContractSize},
		{name: "short ask row", bids: bids, asks: shortRow, unit: 1, want: errMalformedLevels},
		{name: "asks descending", bids: bids, asks: asksDown, unit: 1, want: errUnsortedBook},
		{name: "bids ascending", bids: bidsUp, asks: asks, unit: 1, want: errUnsortedBook},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := bookFromPairs(tc.bids, tc.asks, tc.unit); !errors.Is(err, tc.want) {
				t.Errorf("err=%v, want %v", err, tc.want)
			}
		})
	}
}

func TestFlexFloat_RejectsNonFinite(t *testing.T) {
	for _, raw := range []string{`"NaN"`, `"Infinity"`, `"-Inf"`} {
		var f flexFloat
		if err := json.Unmarshal([]byte(raw), &f); !errors.Is(err, errNotFinite) {
			t.Errorf("%s: err=%v, want errNotFinite", raw, err)
		}
	}
}

func TestRateToBps(t *testing.T) {
	tests := []struct {
		name string
		body string
		want float64
		err  error
	}{
		{name: "string rate", body: `{"r":"0.0006"}`, want: 6},
		{name: "number rate", body: `{"r":0.0002}`, want: 2},
		{name: "zero", body: `{"r":"0"}`, want: 0},
		{name: "absent", body: `{}`, err: errNoTakerFee},
		{name: "negative", body: `{"r":"-0.0006"}`, err: errTakerOutOfRange},
		{name: "absurd", body: `{"r":"0.05"}`, err: errTakerOutOfRange},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var spec struct {
				R *flexFloat `json:"r"`
			}
			if err := json.Unmarshal([]byte(tc.body), &spec); err != nil {
				t.Fatal(err)
			}
			got, err := rateToBps(spec.R)
			if !errors.Is(err, tc.err) || !near(got, tc.want) {
				t.Errorf("got %v err=%v, want %v err=%v", got, err, tc.want, tc.err)
			}
		})
	}
}

const (
	strBook = `{"bids":[["1999","10"]],"asks":[["2001","10"]]}`
	numBook = `{"bids":[[1999,10]],"asks":[[2001,10]]}`
)

func TestCEXQuotes(t *testing.T) {
	tests := []struct {
		name     string
		quote    cexQuoteFunc
		asset    string
		routes   map[string]string
		wantFee  float64
		wantAsk1 float64
	}{
		{
			name: "binance", quote: quoteBinance, asset: "ETH", wantFee: 5, wantAsk1: 10,
			routes: map[string]string{"depth?limit=1000&symbol=ETHUSDT": strBook},
		},
		{
			name: "bybit", quote: quoteBybit, asset: "ETH", wantFee: 5.5, wantAsk1: 10,
			routes: map[string]string{
				"category=linear&limit=500&symbol=ETHUSDT": `{"retCode":0,"result":` +
					`{"b":[["1999","10"]],"a":[["2001","10"]]}}`,
			},
		},
		{
			name: "okx", quote: quoteOKX, asset: "ETH", wantFee: 5, wantAsk1: 1,
			routes: map[string]string{
				"instruments?instType=SWAP&instId=ETH-USDT-SWAP": `{"code":"0",` +
					`"data":[{"ctVal":"0.01"}]}`,
				"books-full?sz=5000&instId=ETH-USDT-SWAP": `{"code":"0","data":` +
					`[{"bids":[["1999","100","3"]],"asks":[["2001","100","2"]]}]}`,
			},
		},
		{
			name: "bitget", quote: quoteBitget, asset: "ETH", wantFee: 6, wantAsk1: 10,
			routes: map[string]string{
				"contracts?productType=usdt-futures&symbol=ETHUSDT": `{"code":"00000",` +
					`"data":[{"takerFeeRate":"0.0006"}]}`,
				"merge-depth?productType=usdt-futures&symbol=ETHUSDT": `{"code":"00000",` +
					`"data":` + numBook + `}`,
			},
		},
		{
			name: "mexc", quote: quoteMEXC, asset: "ETH", wantFee: 2, wantAsk1: 10,
			routes: map[string]string{
				"contract/detail?symbol=ETH_USDT": `{"success":true,` +
					`"data":{"contractSize":0.01,"takerFeeRate":0.0002}}`,
				"contract/depth/ETH_USDT": `{"success":true,` +
					`"data":{"bids":[[1999,1000,1]],"asks":[[2001,1000,1]]}}`,
			},
		},
		{
			name: "gate", quote: quoteGate, asset: "ETH", wantFee: 5, wantAsk1: 1,
			routes: map[string]string{
				"usdt/contracts/ETH_USDT": `{"quanto_multiplier":"0.01"}`,
				"order_book?limit=300&contract=ETH_USDT": `{"bids":[{"p":"1999","s":100}],` +
					`"asks":[{"p":"2001","s":100}]}`,
			},
		},
		{
			name: "kucoin", quote: quoteKuCoin, asset: "BTC", wantFee: 6, wantAsk1: 1,
			routes: map[string]string{
				"contracts/XBTUSDTM": `{"code":"200000",` +
					`"data":{"multiplier":0.001,"takerFeeRate":0.0006}}`,
				"level2/snapshot?symbol=XBTUSDTM": `{"code":"200000",` +
					`"data":{"bids":[[1999,1000]],"asks":[[2001,1000]]}}`,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, err := tc.quote(context.Background(), fakeExchange(tc.routes), tc.asset)
			if err != nil {
				t.Fatal(err)
			}
			if !near(q.takerBps, tc.wantFee) || !near(q.bestBid, 1999) {
				t.Errorf("taker=%v bid=%v, want %v and 1999",
					q.takerBps, q.bestBid, tc.wantFee)
			}
			ask := q.asks
			if len(ask) != 1 || !near(ask[0].Px, 2001) || !near(ask[0].Sz, tc.wantAsk1) {
				t.Errorf("asks=%+v, want 2001 x %v", q.asks, tc.wantAsk1)
			}
		})
	}
}

func TestCEXQuotes_APIError(t *testing.T) {
	tests := []struct {
		name   string
		quote  cexQuoteFunc
		routes map[string]string
	}{
		{
			name: "bybit retCode", quote: quoteBybit,
			routes: map[string]string{
				"orderbook": `{"retCode":10001,"result":` +
					`{"b":[["1999","10"]],"a":[["2001","10"]]}}`,
			},
		},
		{
			name: "bitget code", quote: quoteBitget,
			routes: map[string]string{
				"contracts":   `{"code":"40034","data":[{"takerFeeRate":"0.0006"}]}`,
				"merge-depth": `{"code":"00000","data":` + numBook + `}`,
			},
		},
		{
			name: "mexc success false", quote: quoteMEXC,
			routes: map[string]string{
				"detail": `{"success":false,"data":{"contractSize":0.01,"takerFeeRate":0.0002}}`,
				"depth":  `{"success":true,"data":` + numBook + `}`,
			},
		},
		{
			name: "okx empty instrument", quote: quoteOKX,
			routes: map[string]string{"instruments": `{"code":"0","data":[]}`},
		},
		{
			name: "okx empty book", quote: quoteOKX,
			routes: map[string]string{
				"instruments": `{"code":"0","data":[{"ctVal":"0.01"}]}`,
				"books-full":  `{"code":"0","data":[]}`,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			q, err := tc.quote(context.Background(), fakeExchange(tc.routes), "ETH")
			if err == nil {
				t.Errorf("got %+v, want an error", q)
			}
		})
	}
}

func TestCEXGet_Rejects(t *testing.T) {
	oversized := `{"bids":[],"asks":[],"pad":"` + strings.Repeat("x", maxCEXBody) + `"}`
	tests := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{name: "server error", status: http.StatusServiceUnavailable, body: strBook},
		{name: "oversized body", status: http.StatusOK, body: oversized, want: errBodyTooLarge},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: fixedTransport{status: tc.status, body: tc.body}}
			var book pairBook
			err := cexGet(context.Background(), client, "https://cex.test/depth", &book)
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Errorf("err=%v book=%+v, want an error", err, book)
			}
		})
	}
}

func near(got, want float64) bool {
	return math.Abs(got-want) < 1e-9
}

func respond(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

type routeTransport map[string]string

func (r routeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for key, body := range r {
		if strings.Contains(req.URL.String(), key) {
			return respond(req, http.StatusOK, body), nil
		}
	}
	return respond(req, http.StatusNotFound, "no route"), nil
}

type fixedTransport struct {
	status int
	body   string
}

func (f fixedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return respond(req, f.status, f.body), nil
}

func fakeExchange(routes map[string]string) *http.Client {
	return &http.Client{Transport: routeTransport(routes)}
}
