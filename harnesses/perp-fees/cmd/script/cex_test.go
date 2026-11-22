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
			if len(s.Tiers) != len(tierNotionals) {
				t.Errorf("tiers=%d skipped=%v, want all %d filled",
					len(s.Tiers), s.SkippedTiers, len(tierNotionals))
			}
		})
	}
}

func TestApplyCEXQuote_RejectsBadBook(t *testing.T) {
	tests := []struct {
		name string
		q    cexQuote
		want error
	}{
		{name: "no asks", q: cexQuote{bestBid: 100}, want: errEmptyOrderbook},
		{
			name: "no bid",
			q:    cexQuote{asks: []bookLevel{{Px: 100, Sz: 100}}},
			want: errEmptyOrderbook,
		},
		{
			name: "crossed",
			q:    cexQuote{bestBid: 101, asks: []bookLevel{{Px: 100, Sz: 100}}},
			want: errCrossedBook,
		},
		{name: "too thin", q: cexQuote{bestBid: 99, asks: []bookLevel{{Px: 100, Sz: 1}}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var s PerpSample
			err := applyCEXQuote(&s, tc.q, 1000)
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("err=%v all_in=%v, want %v", err, s.AllInBps, tc.want)
			}
			if s.AllInBps != 0 || len(s.Tiers) != 0 {
				t.Errorf("sample filled on a rejected book: %+v", s)
			}
		})
	}
}

func TestApplyCEXQuote_LockedBook(t *testing.T) {
	var s PerpSample
	q := cexQuote{bestBid: 100, asks: []bookLevel{{Px: 100, Sz: 100}, {Px: 100, Sz: 100}}}
	if err := applyCEXQuote(&s, q, 1000); err != nil || s.SpreadBps != 0 {
		t.Errorf("err=%v spread=%v, want a 0 bps reading", err, s.SpreadBps)
	}
}

func TestFetchCEX(t *testing.T) {
	book := cexQuote{
		takerBps: 5,
		bestBid:  1999,
		asks:     []bookLevel{{Px: 2001, Sz: 1}, {Px: 2003, Sz: 10}},
	}
	tests := []struct {
		name      string
		quote     cexQuoteFunc
		wantErr   bool
		wantAllIn float64
	}{
		{
			name: "quote error",
			quote: func(context.Context, *http.Client, string) (cexQuote, error) {
				return cexQuote{}, errAPI
			},
			wantErr: true,
		},
		{
			name: "book",
			quote: func(context.Context, *http.Client, string) (cexQuote, error) {
				return book, nil
			},
			wantAllIn: 15,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v := VenueConfig{Slug: "binance", Asset: "ETH", NotionalUSD: 4004}
			s := fetchCEX(v, tc.quote, http.DefaultClient)
			if (s.Err != "") != tc.wantErr || !near(s.AllInBps, tc.wantAllIn) {
				t.Errorf("err=%q all_in=%v, want error %v and %v",
					s.Err, s.AllInBps, tc.wantErr, tc.wantAllIn)
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
		{name: "short ask row", bids: bids, asks: shortRow, unit: 1, want: errMalformedBook},
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

func TestBookFromPairs_EqualAskLevels(t *testing.T) {
	asks := [][]flexFloat{{100, 1}, {100, 2}}
	_, levels, err := bookFromPairs([][]flexFloat{{99, 1}}, asks, 1)
	if err != nil || len(levels) != 2 {
		t.Errorf("err=%v levels=%v, want both levels kept", err, levels)
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

const numBook = `{"bids":[[1999,10]],"asks":[[2001,10]]}`

func TestCEXQuotes(t *testing.T) {
	tests := []struct {
		slug     string
		asset    string
		routes   map[string]string
		wantFee  float64
		wantAsk1 float64
	}{
		{
			slug: "binance", asset: "ETH", wantFee: binanceTakerBps, wantAsk1: 10,
			routes: map[string]string{
				"fapi.binance.com/fapi/v1/depth?limit=1000&symbol=ETHUSDT": `{` +
					`"bids":[["1999","10"]],"asks":[["2001","10"]]}`,
			},
		},
		{
			slug: "bybit", asset: "ETH", wantFee: bybitTakerBps, wantAsk1: 10,
			routes: map[string]string{
				"api.bybit.com/v5/market/orderbook?" +
					"category=linear&limit=500&symbol=ETHUSDT": `{` +
					`"retCode":0,"result":` +
					`{"b":[["1999","10"]],"a":[["2001","10"]]}}`,
			},
		},
		{
			slug: "okx", asset: "ETH", wantFee: okxTakerBps, wantAsk1: 1,
			routes: map[string]string{
				"okx.com/api/v5/public/instruments?instType=SWAP&instId=ETH-USDT-SWAP": `{` +
					`"code":"0","data":[{"ctVal":"0.01"}]}`,
				"okx.com/api/v5/market/books-full?sz=5000&instId=ETH-USDT-SWAP": `{"code":"0","data":` +
					`[{"bids":[["1999","100","3"]],"asks":[["2001","100","2"]]}]}`,
			},
		},
		{
			slug: "bitget", asset: "ETH", wantFee: 6.1, wantAsk1: 10,
			routes: map[string]string{
				"bitget.com/api/v2/mix/market/contracts?" +
					"productType=usdt-futures&symbol=ETHUSDT": `{"code":"00000",` +
					`"data":[{"takerFeeRate":"0.00061"}]}`,
				"bitget.com/api/v2/mix/market/merge-depth?" +
					"productType=usdt-futures&symbol=ETHUSDT&limit=max": `{"code":"00000","data":` +
					numBook + `}`,
			},
		},
		{
			slug: "mexc", asset: "ETH", wantFee: 2, wantAsk1: 10,
			routes: map[string]string{
				"contract.mexc.com/api/v1/contract/detail?symbol=ETH_USDT": `{"success":true,` +
					`"data":{"contractSize":0.01,"takerFeeRate":0.0002}}`,
				"contract.mexc.com/api/v1/contract/depth/ETH_USDT": `{"success":true,` +
					`"data":{"bids":[[1999,1000,1]],"asks":[[2001,1000,1]]}}`,
			},
		},
		{
			slug: "gate", asset: "ETH", wantFee: gateTakerBps, wantAsk1: 1,
			routes: map[string]string{
				"gateio.ws/api/v4/futures/usdt/contracts/ETH_USDT": `{"quanto_multiplier":"0.01"}`,
				"gateio.ws/api/v4/futures/usdt/order_book?limit=300&contract=ETH_USDT": `{` +
					`"bids":[{"p":"1999","s":100}],` +
					`"asks":[{"p":"2001","s":100}]}`,
			},
		},
		{
			slug: "kucoin", asset: "BTC", wantFee: 5.7, wantAsk1: 1,
			routes: map[string]string{
				"kucoin.com/api/v1/contracts/XBTUSDTM": `{"code":"200000",` +
					`"data":{"multiplier":0.001,"takerFeeRate":0.00057}}`,
				"kucoin.com/api/v1/level2/snapshot?symbol=XBTUSDTM": `{"code":"200000",` +
					`"data":{"bids":[[1999,1000]],"asks":[[2001,1000]]}}`,
			},
		},
		{
			slug: "kucoin", asset: "ETH", wantFee: 5.8, wantAsk1: 10,
			routes: map[string]string{
				"kucoin.com/api/v1/contracts/ETHUSDTM": `{"code":"200000",` +
					`"data":{"multiplier":0.01,"takerFeeRate":0.00058}}`,
				"kucoin.com/api/v1/level2/snapshot?symbol=ETHUSDTM": `{"code":"200000",` +
					`"data":{"bids":[[1999,1000]],"asks":[[2001,1000]]}}`,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.slug+"/"+tc.asset, func(t *testing.T) {
			quote, ok := cexQuoteFor(tc.slug)
			if !ok {
				t.Fatalf("no quote for %s", tc.slug)
			}
			q, err := quote(context.Background(), fakeExchange(tc.routes), tc.asset)
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
		slug   string
		routes map[string]string
		want   error
	}{
		{
			name: "bybit retCode", slug: "bybit", want: errAPI,
			routes: map[string]string{
				"orderbook": `{"retCode":10001,"retMsg":"params error",` +
					`"result":{"b":[["1999","10"]],"a":[["2001","10"]]}}`,
			},
		},
		{
			name: "bitget code", slug: "bitget", want: errAPI,
			routes: map[string]string{
				"contracts":   `{"code":"40034","data":[{"takerFeeRate":"0.0006"}]}`,
				"merge-depth": `{"code":"00000","data":` + numBook + `}`,
			},
		},
		{
			name: "bitget empty contracts", slug: "bitget", want: errAssetNotFound,
			routes: map[string]string{
				"contracts":   `{"code":"00000","data":[]}`,
				"merge-depth": `{"code":"00000","data":` + numBook + `}`,
			},
		},
		{
			name: "mexc success false", slug: "mexc", want: errAPI,
			routes: map[string]string{
				"detail": `{"success":false,"data":{"contractSize":0.01,"takerFeeRate":0.0002}}`,
				"depth":  `{"success":true,"data":` + numBook + `}`,
			},
		},
		{
			name: "okx code", slug: "okx", want: errAPI,
			routes: map[string]string{
				"instruments": `{"code":"51001","msg":"Instrument ID does not exist",` +
					`"data":[{"ctVal":"0.01"}]}`,
				"books-full": `{"code":"0","data":[` + numBook + `]}`,
			},
		},
		{
			name: "okx empty instrument", slug: "okx", want: errAssetNotFound,
			routes: map[string]string{
				"instruments": `{"code":"0","data":[]}`,
				"books-full":  `{"code":"0","data":[` + numBook + `]}`,
			},
		},
		{
			name: "okx empty book", slug: "okx", want: errEmptyOrderbook,
			routes: map[string]string{
				"instruments": `{"code":"0","data":[{"ctVal":"0.01"}]}`,
				"books-full":  `{"code":"0","data":[]}`,
			},
		},
		{
			name: "kucoin code", slug: "kucoin", want: errAPI,
			routes: map[string]string{
				"contracts": `{"code":"400100","msg":"bad symbol",` +
					`"data":{"multiplier":0.01,"takerFeeRate":0.0006}}`,
				"snapshot": `{"code":"200000","data":` + numBook + `}`,
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			quote, _ := cexQuoteFor(tc.slug)
			q, err := quote(context.Background(), fakeExchange(tc.routes), "ETH")
			if !errors.Is(err, tc.want) {
				t.Errorf("got %+v err=%v, want %v", q, err, tc.want)
			}
		})
	}
}

func TestGetJSON_ServerError(t *testing.T) {
	client := &http.Client{
		Transport: fixedTransport{status: http.StatusServiceUnavailable, body: numBook},
	}
	var book pairBook
	if err := getJSON(context.Background(), client, "https://cex.test/depth", &book); err == nil {
		t.Errorf("book=%+v, want an error", book)
	}
}

func TestGetJSON_StopsReadingPastCap(t *testing.T) {
	client := &http.Client{Transport: endlessTransport{}}
	var book pairBook
	err := getJSON(context.Background(), client, "https://cex.test/depth", &book)
	if !errors.Is(err, errBodyTooLarge) {
		t.Errorf("err=%v, want %v", err, errBodyTooLarge)
	}
}

func TestRecordSample_FundingOnlyWhereRead(t *testing.T) {
	read := PerpSample{Venue: "funding-test", Asset: "ETH", HasFunding: true}
	recordSample(read)
	if !fundingGauge.DeleteLabelValues("funding-test", "ETH") {
		t.Fatal("funding read but not published")
	}
	recordSample(read)
	recordSample(PerpSample{Venue: "funding-test", Asset: "ETH"})
	if fundingGauge.DeleteLabelValues("funding-test", "ETH") {
		t.Error("funding series kept for a sample that read no funding")
	}
}

func TestSetFunding(t *testing.T) {
	tests := []struct {
		raw  string
		want float64
		ok   bool
	}{
		{raw: "0.0001", want: 1, ok: true},
		{raw: "-0.0002", want: -2, ok: true},
		{raw: "", ok: false},
		{raw: "NaN", ok: false},
		{raw: "+Inf", ok: false},
	}
	for _, tc := range tests {
		t.Run(tc.raw, func(t *testing.T) {
			var s PerpSample
			s.setFunding(tc.raw, bpsPerUnit)
			if s.HasFunding != tc.ok || !near(s.FundingRatePerHrBps, tc.want) {
				t.Errorf("got %v %v, want %v %v",
					s.FundingRatePerHrBps, s.HasFunding, tc.want, tc.ok)
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

var errReadPastCap = errors.New("read past the body cap")

type endlessBody struct{ read int }

func (b *endlessBody) Read(p []byte) (int, error) {
	if b.read > maxResponseBody {
		return 0, errReadPastCap
	}
	for i := range p {
		p[i] = 'x'
	}
	b.read += len(p)
	return len(p), nil
}

func (b *endlessBody) Close() error { return nil }

type endlessTransport struct{}

func (endlessTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: &endlessBody{}, Request: req}, nil
}

func fakeExchange(routes map[string]string) *http.Client {
	return &http.Client{Transport: routeTransport(routes)}
}
