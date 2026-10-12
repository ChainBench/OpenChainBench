package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// PapertradeNativeSource reads Papertrade, a synthetic perp venue on Hyperliquid
// that launched 2026-10-10 and lists exactly two markets, BTC and ETH.
//
// The API is undocumented but public and keyless, and it is the same source
// DefiLlama's own adapter uses. Three routes matter. Note the namespaces are
// /state and /query: the root and /api/* are both 404.
//
//	GET /query/protocol/history?interval=1d   volume, trades, users, tvl,
//	                                          traderPnl, liquidation
//	GET /query/house/history?interval=1d      bl/bs/el/es (open interest by
//	                                          side), lp, q (payout queue)
//	GET /state/trading                        live per-instrument parameters
//
// Both history payloads are COLUMNAR and CUMULATIVE, and the two use different
// time encodings: protocol carries startMs plus a fixed intervalMs, house
// carries baseTimeMs plus an explicit timeOffsetsMs array. Daily figures are
// therefore deltas between buckets, and the final bucket is partial, so the
// last COMPLETE bucket is used for anything labelled 24h.
//
// Open interest: the four side columns ADD. Every position faces the house
// rather than another trader, so halving the sum the way one would on an order
// book venue would understate it by half.
//
// Volume is deliberately NOT published to the volume-share benches. The figure
// is real but it is notional at up to 1000x leverage against a $10 minimum
// margin: the average trade is about $2.6M of notional, the venue turned over
// several thousand times its own TVL on day one, and a raw column would rank a
// three-day-old venue above Hyperliquid on leverage rather than on activity.
// It is emitted here so the ratio benches (volume/OI) can use it, because there
// the leverage appears on both sides of the fraction and the ratio is the point.
type PapertradeNativeSource struct {
	client *http.Client
}

func NewPapertradeNativeSource() *PapertradeNativeSource {
	return &PapertradeNativeSource{
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (s *PapertradeNativeSource) Name() string { return srcPapertradeNative }

// papertradeHistory covers both payload shapes. StartMs plus IntervalMs is the
// protocol form; BaseTimeMs plus TimeOffsetsMs is the house form.
type papertradeHistory struct {
	StartMs       int64                `json:"startMs"`
	IntervalMs    int64                `json:"intervalMs"`
	BaseTimeMs    int64                `json:"baseTimeMs"`
	TimeOffsetsMs []int64              `json:"timeOffsetsMs"`
	Columns       map[string][]float64 `json:"columns"`
}

// lastComplete returns the value of a column at the last complete bucket and at
// the one before it, so a daily delta can be taken without counting the partial
// bucket that is still filling.
func (h *papertradeHistory) lastComplete(col string) (cur, prev float64, ok bool) {
	v, exists := h.Columns[col]
	if !exists || len(v) < 3 {
		return 0, 0, false
	}
	// len-1 is partial, so the last complete bucket is len-2.
	return v[len(v)-2], v[len(v)-3], true
}

func (h *papertradeHistory) latest(col string) (float64, bool) {
	v, exists := h.Columns[col]
	if !exists || len(v) == 0 {
		return 0, false
	}
	return v[len(v)-1], true
}

type papertradeState struct {
	Instruments [][]json.RawMessage `json:"instruments"`
}

func (s *PapertradeNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "papertrade"

	proto, err := s.history("https://exchange.papertrade.xyz/query/protocol/history?interval=1d")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPapertradeNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] protocol err: %v\n", venue, srcPapertradeNative, err)
		return res, nil
	}

	// Volume over the last complete day, from the cumulative counter.
	if cur, prev, ok := proto.lastComplete("volume"); ok && cur > prev {
		res.SetIfPositive(venue, mVolume24h, cur-prev)
	}
	if tvl, ok := proto.latest("tvl"); ok && tvl > 0 {
		res.SetIfPositive(venue, mTVL, tvl)
	}

	// Open interest: the four sides add, see the type comment.
	house, err := s.history("https://exchange.papertrade.xyz/query/house/history?interval=1d")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPapertradeNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] house err: %v\n", venue, srcPapertradeNative, err)
	} else {
		var oi float64
		for _, side := range []string{"bl", "bs", "el", "es"} {
			if v, ok := house.latest(side); ok {
				oi += v
			}
		}
		if oi > 0 {
			res.SetIfPositive(venue, mOI, oi)
		}
	}

	// Active markets, read from the live instrument list rather than hardcoded,
	// so the count follows the venue if it ever lists a third market.
	if n, err := s.marketCount(); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcPapertradeNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] state err: %v\n", venue, srcPapertradeNative, err)
	} else if n > 0 {
		res.SetIfPositive(venue, mActiveMarkets, float64(n))
		// Both markets are crypto and the venue lists nothing else, so the
		// breadth classifier can be told directly instead of inferring. Use
		// the helpers rather than writing the maps: newSourceResult only
		// initialises Values and Funding, so a direct assignment to Breadth
		// or CryptoSymbols writes to a nil map and panics.
		res.SetBreadth(venue, breadthCounter{classCrypto: n})
		res.AddCryptoSymbol("BTC")
		res.AddCryptoSymbol("ETH")
	}

	fmt.Printf("[perp-cohort][%s][%s] ok: %v\n", venue, srcPapertradeNative, res.Values[venue])
	return res, nil
}

func (s *PapertradeNativeSource) marketCount() (int, error) {
	body, err := s.get("https://exchange.papertrade.xyz/state/trading")
	if err != nil {
		return 0, err
	}
	var st papertradeState
	if err := json.Unmarshal(body, &st); err != nil {
		return 0, fmt.Errorf("parse state: %w", err)
	}
	return len(st.Instruments), nil
}

func (s *PapertradeNativeSource) history(url string) (*papertradeHistory, error) {
	body, err := s.get(url)
	if err != nil {
		return nil, err
	}
	var h papertradeHistory
	if err := json.Unmarshal(body, &h); err != nil {
		return nil, fmt.Errorf("parse history: %w", err)
	}
	if len(h.Columns) == 0 {
		return nil, fmt.Errorf("history has no columns")
	}
	return &h, nil
}

func (s *PapertradeNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		snippet := string(body)
		if len(snippet) > 100 {
			snippet = snippet[:100]
		}
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, snippet)
	}
	return body, nil
}
