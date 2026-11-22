package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	binanceTakerBps = 5.0
	bybitTakerBps   = 5.5
	okxTakerBps     = 5.0
	gateTakerBps    = 5.0

	okxOK    = "0"
	bitgetOK = "00000"
	kucoinOK = "200000"

	maxTakerBps = 100.0
	maxAPIMsg   = 200
	cexTimeout  = 8 * time.Second
)

var (
	errAssetNotFound   = errors.New("asset_not_found")
	errAPI             = errors.New("api_error")
	errCrossedBook     = errors.New("crossed_book")
	errNoContractSize  = errors.New("contract_size_missing")
	errNoTakerFee      = errors.New("taker_fee_missing")
	errTakerOutOfRange = errors.New("taker_fee_out_of_range")
	errMalformedLevels = errors.New("malformed_orderbook")
	errUnsortedBook    = errors.New("unsorted_orderbook")
	errNotFinite       = errors.New("not_finite")
)

type cexQuote struct {
	takerBps float64
	bestBid  float64
	asks     []bookLevel
}

type cexQuoteFunc func(ctx context.Context, client *http.Client, asset string) (cexQuote, error)

func cexQuoteFor(slug string) (cexQuoteFunc, bool) {
	switch slug {
	case "binance":
		return quoteBinance, true
	case "bybit":
		return quoteBybit, true
	case "okx":
		return quoteOKX, true
	case "bitget":
		return quoteBitget, true
	case "mexc":
		return quoteMEXC, true
	case "gate":
		return quoteGate, true
	case "kucoin":
		return quoteKuCoin, true
	}
	return nil, false
}

type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	n, err := strconv.ParseFloat(strings.Trim(string(b), `"`), 64)
	if err != nil {
		return fmt.Errorf("parse number %s: %w", truncate(string(b), 40), err)
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return fmt.Errorf("parse number %s: %w", truncate(string(b), 40), errNotFinite)
	}
	*f = flexFloat(n)
	return nil
}

func rateToBps(rate *flexFloat) (float64, error) {
	if rate == nil {
		return 0, errNoTakerFee
	}
	bps := float64(*rate) * 10000
	if bps < 0 || bps > maxTakerBps {
		return 0, fmt.Errorf("%w: %.4f bps", errTakerOutOfRange, bps)
	}
	return bps, nil
}

func apiError(code any, msg string) error {
	return fmt.Errorf("%w %v %q", errAPI, code, truncate(msg, maxAPIMsg))
}

func fetchCEX(v VenueConfig, quote cexQuoteFunc, client *http.Client) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), cexTimeout)
	defer cancel()
	q, err := quote(ctx, client, v.Asset)
	if err == nil {
		err = applyCEXQuote(&s, q, v.NotionalUSD)
	}
	if err != nil {
		s.Err = err.Error()
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}

func applyCEXQuote(s *PerpSample, q cexQuote, notional float64) error {
	if len(q.asks) == 0 || q.bestBid <= 0 {
		return errEmptyOrderbook
	}
	if q.asks[0].Px < q.bestBid {
		return fmt.Errorf("%w: bid %.4f above ask %.4f", errCrossedBook, q.bestBid, q.asks[0].Px)
	}
	mid := (q.bestBid + q.asks[0].Px) / 2
	effective, err := walkBookForNotional(q.asks, notional)
	if err != nil {
		return fmt.Errorf("walk: %w", err)
	}
	s.MidPrice = mid
	s.TakerFeeBps = q.takerBps
	s.SpreadBps = (effective - mid) / mid * 10000
	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	applyBookTiers(s, q.asks, mid)
	return nil
}

func bookFromPairs(bids, asks [][]flexFloat, unit float64) (float64, []bookLevel, error) {
	if unit <= 0 {
		return 0, nil, errNoContractSize
	}
	if len(bids) == 0 || len(bids[0]) < 2 {
		return 0, nil, errEmptyOrderbook
	}
	if len(bids) > 1 && len(bids[1]) > 0 && bids[1][0] > bids[0][0] {
		return 0, nil, errUnsortedBook
	}
	levels := make([]bookLevel, 0, len(asks))
	for i, r := range asks {
		if len(r) < 2 {
			return 0, nil, errMalformedLevels
		}
		if i > 0 && r[0] < asks[i-1][0] {
			return 0, nil, errUnsortedBook
		}
		levels = append(levels, bookLevel{Px: float64(r[0]), Sz: float64(r[1]) * unit})
	}
	return float64(bids[0][0]), levels, nil
}

type pairBook struct {
	Bids [][]flexFloat `json:"bids"`
	Asks [][]flexFloat `json:"asks"`
}

func quoteBinance(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	var book pairBook
	url := "https://fapi.binance.com/fapi/v1/depth?limit=1000&symbol=" + asset + "USDT"
	if err := getJSON(ctx, client, url, &book); err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	bid, asks, err := bookFromPairs(book.Bids, book.Asks, 1)
	return cexQuote{takerBps: binanceTakerBps, bestBid: bid, asks: asks}, err
}

func quoteBybit(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	var resp struct {
		RetCode int    `json:"retCode"`
		RetMsg  string `json:"retMsg"`
		Result  struct {
			Bids [][]flexFloat `json:"b"`
			Asks [][]flexFloat `json:"a"`
		} `json:"result"`
	}
	url := "https://api.bybit.com/v5/market/orderbook?category=linear&limit=500&symbol=" +
		asset + "USDT"
	if err := getJSON(ctx, client, url, &resp); err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	if resp.RetCode != 0 {
		return cexQuote{}, fmt.Errorf("orderbook: %w", apiError(resp.RetCode, resp.RetMsg))
	}
	bid, asks, err := bookFromPairs(resp.Result.Bids, resp.Result.Asks, 1)
	return cexQuote{takerBps: bybitTakerBps, bestBid: bid, asks: asks}, err
}

func quoteOKX(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	base := "https://www.okx.com/api/v5/"
	inst := asset + "-USDT-SWAP"
	specs, err := codedGet[[]struct {
		CtVal flexFloat `json:"ctVal"`
	}](ctx, client, base+"public/instruments?instType=SWAP&instId="+inst, okxOK)
	if err != nil {
		return cexQuote{}, fmt.Errorf("instrument: %w", err)
	}
	if len(specs) == 0 {
		return cexQuote{}, fmt.Errorf("instrument: %w", errAssetNotFound)
	}
	bookURL := base + "market/books-full?sz=5000&instId=" + inst
	books, err := codedGet[[]pairBook](ctx, client, bookURL, okxOK)
	if err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	if len(books) == 0 {
		return cexQuote{}, fmt.Errorf("orderbook: %w", errEmptyOrderbook)
	}
	bid, asks, err := bookFromPairs(books[0].Bids, books[0].Asks, float64(specs[0].CtVal))
	return cexQuote{takerBps: okxTakerBps, bestBid: bid, asks: asks}, err
}

type codedResponse[T any] struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	Data T      `json:"data"`
}

func codedGet[T any](ctx context.Context, client *http.Client, url, okCode string) (T, error) {
	var resp codedResponse[T]
	if err := getJSON(ctx, client, url, &resp); err != nil {
		return resp.Data, err
	}
	if resp.Code != okCode {
		return resp.Data, apiError(resp.Code, resp.Msg)
	}
	return resp.Data, nil
}

func quoteBitget(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	base := "https://api.bitget.com/api/v2/mix/market/"
	query := "?productType=usdt-futures&symbol=" + asset + "USDT"
	contracts, err := codedGet[[]struct {
		TakerFeeRate *flexFloat `json:"takerFeeRate"`
	}](ctx, client, base+"contracts"+query, bitgetOK)
	if err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	if len(contracts) == 0 {
		return cexQuote{}, fmt.Errorf("contract: %w", errAssetNotFound)
	}
	taker, err := rateToBps(contracts[0].TakerFeeRate)
	if err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	book, err := codedGet[pairBook](ctx, client, base+"merge-depth"+query+"&limit=max", bitgetOK)
	if err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	bid, asks, err := bookFromPairs(book.Bids, book.Asks, 1)
	return cexQuote{takerBps: taker, bestBid: bid, asks: asks}, err
}

type mexcResponse[T any] struct {
	Success bool `json:"success"`
	Code    int  `json:"code"`
	Data    T    `json:"data"`
}

func mexcGet[T any](ctx context.Context, client *http.Client, url string) (T, error) {
	var resp mexcResponse[T]
	if err := getJSON(ctx, client, url, &resp); err != nil {
		return resp.Data, err
	}
	if !resp.Success {
		return resp.Data, apiError(resp.Code, "")
	}
	return resp.Data, nil
}

func quoteMEXC(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	base := "https://contract.mexc.com/api/v1/contract/"
	symbol := asset + "_USDT"
	spec, err := mexcGet[struct {
		ContractSize flexFloat  `json:"contractSize"`
		TakerFeeRate *flexFloat `json:"takerFeeRate"`
	}](ctx, client, base+"detail?symbol="+symbol)
	if err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	taker, err := rateToBps(spec.TakerFeeRate)
	if err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	book, err := mexcGet[pairBook](ctx, client, base+"depth/"+symbol)
	if err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	bid, asks, err := bookFromPairs(book.Bids, book.Asks, float64(spec.ContractSize))
	return cexQuote{takerBps: taker, bestBid: bid, asks: asks}, err
}

type gateLevel struct {
	Px flexFloat `json:"p"`
	Sz flexFloat `json:"s"`
}

func gatePairs(levels []gateLevel) [][]flexFloat {
	rows := make([][]flexFloat, 0, len(levels))
	for _, l := range levels {
		rows = append(rows, []flexFloat{l.Px, l.Sz})
	}
	return rows
}

func quoteGate(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	base := "https://api.gateio.ws/api/v4/futures/usdt/"
	contract := asset + "_USDT"
	var spec struct {
		QuantoMultiplier flexFloat `json:"quanto_multiplier"`
	}
	if err := getJSON(ctx, client, base+"contracts/"+contract, &spec); err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	var book struct {
		Bids []gateLevel `json:"bids"`
		Asks []gateLevel `json:"asks"`
	}
	url := base + "order_book?limit=300&contract=" + contract
	if err := getJSON(ctx, client, url, &book); err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	unit := float64(spec.QuantoMultiplier)
	bid, asks, err := bookFromPairs(gatePairs(book.Bids), gatePairs(book.Asks), unit)
	return cexQuote{takerBps: gateTakerBps, bestBid: bid, asks: asks}, err
}

func kucoinSymbol(asset string) string {
	if asset == "BTC" {
		return "XBTUSDTM"
	}
	return asset + "USDTM"
}

func quoteKuCoin(ctx context.Context, client *http.Client, asset string) (cexQuote, error) {
	base := "https://api-futures.kucoin.com/api/v1/"
	symbol := kucoinSymbol(asset)
	spec, err := codedGet[struct {
		Multiplier   flexFloat  `json:"multiplier"`
		TakerFeeRate *flexFloat `json:"takerFeeRate"`
	}](ctx, client, base+"contracts/"+symbol, kucoinOK)
	if err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	taker, err := rateToBps(spec.TakerFeeRate)
	if err != nil {
		return cexQuote{}, fmt.Errorf("contract: %w", err)
	}
	book, err := codedGet[pairBook](ctx, client, base+"level2/snapshot?symbol="+symbol, kucoinOK)
	if err != nil {
		return cexQuote{}, fmt.Errorf("orderbook: %w", err)
	}
	bid, asks, err := bookFromPairs(book.Bids, book.Asks, float64(spec.Multiplier))
	return cexQuote{takerBps: taker, bestBid: bid, asks: asks}, err
}
