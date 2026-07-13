package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Reference leg: Yahoo Finance, keyless. One spark batch call fetches
// the latest price for every symbol; one chart call (AAPL as the
// bellwether) fetches the day's exact session windows, which Yahoo
// publishes holiday-aware so the harness never maintains an NYSE
// calendar. Verified 2026-07-13 from the harness host: clean 200s with
// a browser User-Agent (datacenter IP), 70-130ms.
//
// Market state is derived from currentTradingPeriod epochs:
// pre / regular / post / closed. Deviation samples carry the state as
// a label so the bench can pin its headline to regular hours and read
// the weekend drift from the closed-state series.

const (
	sparkHost = "https://query1.finance.yahoo.com/v8/finance/spark"
	chartHost = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL"
	yahooUA   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

type refQuote struct {
	Price   float64
	AsOfSec int64
}

type tradingPeriods struct {
	PreStart, PreEnd         int64
	RegularStart, RegularEnd int64
	PostStart, PostEnd       int64
	FetchedAt                time.Time
}

// fetchReferencePrices returns the freshest Yahoo price per symbol
// (lowercased) from one spark batch call. When the market is closed
// the spark meta still carries regularMarketPrice = last close, which
// is exactly the weekend reference we want.
func fetchReferencePrices(client *http.Client) map[string]refQuote {
	syms := make([]string, 0, len(assets))
	for _, a := range assets {
		syms = append(syms, a.Symbol)
	}
	url := sparkHost + "?symbols=" + strings.Join(syms, ",") + "&range=1d&interval=5m"
	raw, status := yahooGet(client, url)
	if raw == nil {
		tspSourceCall.WithLabelValues("yahoo", status).Inc()
		// Rotate to query2 once before giving up this tick.
		raw, status = yahooGet(client, strings.Replace(url, "query1", "query2", 1))
		if raw == nil {
			tspSourceCall.WithLabelValues("yahoo", status).Inc()
			return nil
		}
	}
	tspSourceCall.WithLabelValues("yahoo", "ok").Inc()

	// Spark response: {"spark":{"result":[{"symbol":"AAPL","response":[{"meta":{...}}]}]}}
	// or the flatter {"AAPL":{...}} shape depending on edge; handle both.
	prices := make(map[string]refQuote, len(syms))
	var envel struct {
		Spark struct {
			Result []struct {
				Symbol   string `json:"symbol"`
				Response []struct {
					Meta struct {
						RegularMarketPrice float64 `json:"regularMarketPrice"`
						RegularMarketTime  int64   `json:"regularMarketTime"`
					} `json:"meta"`
				} `json:"response"`
			} `json:"result"`
		} `json:"spark"`
	}
	if err := json.Unmarshal(raw, &envel); err == nil && len(envel.Spark.Result) > 0 {
		for _, r := range envel.Spark.Result {
			if len(r.Response) == 0 || r.Response[0].Meta.RegularMarketPrice <= 0 {
				continue
			}
			prices[strings.ToLower(r.Symbol)] = refQuote{
				Price:   r.Response[0].Meta.RegularMarketPrice,
				AsOfSec: r.Response[0].Meta.RegularMarketTime,
			}
		}
		return prices
	}
	var flat map[string]struct {
		RegularMarketPrice float64 `json:"regularMarketPrice"`
		Timestamp          []int64 `json:"timestamp"`
	}
	if err := json.Unmarshal(raw, &flat); err == nil {
		for sym, v := range flat {
			if v.RegularMarketPrice <= 0 {
				continue
			}
			q := refQuote{Price: v.RegularMarketPrice}
			if n := len(v.Timestamp); n > 0 {
				q.AsOfSec = v.Timestamp[n-1]
			}
			prices[strings.ToLower(sym)] = q
		}
		return prices
	}
	tspSourceCall.WithLabelValues("yahoo", "parse").Inc()
	return nil
}

// fetchTradingPeriods reads currentTradingPeriod from one chart call.
// Refreshed every 30 minutes; between refreshes marketState() reuses
// the cached windows.
func fetchTradingPeriods(client *http.Client) *tradingPeriods {
	raw, status := yahooGet(client, chartHost+"?range=1d&interval=5m")
	if raw == nil {
		tspSourceCall.WithLabelValues("yahoo_chart", status).Inc()
		return nil
	}
	var envel struct {
		Chart struct {
			Result []struct {
				Meta struct {
					CurrentTradingPeriod struct {
						Pre     struct{ Start, End int64 } `json:"pre"`
						Regular struct{ Start, End int64 } `json:"regular"`
						Post    struct{ Start, End int64 } `json:"post"`
					} `json:"currentTradingPeriod"`
				} `json:"meta"`
			} `json:"result"`
		} `json:"chart"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || len(envel.Chart.Result) == 0 {
		tspSourceCall.WithLabelValues("yahoo_chart", "parse").Inc()
		return nil
	}
	m := envel.Chart.Result[0].Meta.CurrentTradingPeriod
	tspSourceCall.WithLabelValues("yahoo_chart", "ok").Inc()
	return &tradingPeriods{
		PreStart: m.Pre.Start, PreEnd: m.Pre.End,
		RegularStart: m.Regular.Start, RegularEnd: m.Regular.End,
		PostStart: m.Post.Start, PostEnd: m.Post.End,
		FetchedAt: time.Now(),
	}
}

func (tp *tradingPeriods) state(now time.Time) string {
	if tp == nil {
		return "unknown"
	}
	u := now.Unix()
	switch {
	case u >= tp.RegularStart && u < tp.RegularEnd:
		return "regular"
	case u >= tp.PreStart && u < tp.PreEnd:
		return "pre"
	case u >= tp.PostStart && u < tp.PostEnd:
		return "post"
	default:
		return "closed"
	}
}

func yahooGet(client *http.Client, url string) ([]byte, string) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, "request_build"
	}
	req.Header.Set("User-Agent", yahooUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "network"
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
	if err != nil {
		return nil, "read"
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Sprintf("http_%d", resp.StatusCode)
	}
	return raw, "ok"
}
