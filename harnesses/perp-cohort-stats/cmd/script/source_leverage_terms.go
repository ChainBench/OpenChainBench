package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// LeverageTermsSource publishes what a trader actually faces at a chosen
// leverage on a given market: how far price has to move against the position
// before it is liquidated, and how much collateral comes back when it is.
// Four venues, two markets, seven leverage settings.
//
// THE MODEL. Every venue reduces to one number, the maintenance requirement m
// expressed as a share of NOTIONAL, and then:
//
//	room to liquidation = 1/L - m        (a share of price)
//	collateral returned = m * L          (a share of the margin posted)
//
// because a position at leverage L posts 1/L of notional as margin and is
// liquidated when its equity falls to m. The venues differ only in what sets
// m, and that difference is the whole point of the bench:
//
//	dYdX          m = maintenanceMarginFraction, published per market
//	Hyperliquid   m = 1/(2*maxLeverage), the documented halving rule
//	Gains         m = (1 - threshold)/L, so the threshold is a share of
//	              COLLATERAL and the room comes out as threshold/L
//	Papertrade    m = bustBuffer, a fixed share of PRICE
//
// Gains' m shrinks with leverage, which keeps the room proportional to it.
// Papertrade's m does not move at all, so it eats a fixed 5 basis points of
// room at every leverage: negligible at 10x, roughly half the margin at 1000x.
//
// THE PAPERTRADE EXCEPTION. Everywhere else m*L is what the trader gets back.
// On Papertrade it is not: their docs call crossing the bust price a "hard
// bust" which "forfeits the full isolated margin, even if a voluntary close
// immediately beforehand could return some equity". So the returned share is
// published as a real zero, and the m*L a voluntary close would have returned
// is a nuance the bench text carries rather than a column.
//
// Reading that buffer as the room itself, rather than as an offset before the
// zero-equity price, understates the room and is wrong: their own docs work
// the 1000x case and get "a move of about 0.052%", which is 1/1000 minus the
// buffer, not the buffer.
type LeverageTermsSource struct {
	client *http.Client
}

func NewLeverageTermsSource() *LeverageTermsSource {
	return &LeverageTermsSource{client: &http.Client{Timeout: 25 * time.Second}}
}

func (s *LeverageTermsSource) Name() string { return srcLeverageTerms }

const (
	gainsArbRPC     = "https://arbitrum-one-rpc.publicnode.com"
	gainsDiamondArb = "0xFF162c694eAA571f685030649814282eA457f169"
	// First four bytes of the keccak-256 of the signature, hardcoded so the
	// harness needs no hashing dependency.
	selPairMaxLev   = "0x281b693c" // pairMaxLeverage(uint256), 1e3
	selPairLiqParam = "0x6633ced6" // getPairLiquidationParams(uint256)

	leverageTermsUA = "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com"
)

// gainsDegenPairs maps the market label to its pair index on the diamond. These
// are the x500 cohort, deliberately not the standard BTC/USD and ETH/USD pairs
// which cap at 200x.
var gainsDegenPairs = map[string]int64{"BTC": 300, "ETH": 313}

// leverageTermsMarkets are the only two assets all four venues list, which is
// what makes the rows comparable at all.
var leverageTermsMarkets = map[string]bool{"BTC": true, "ETH": true}

// leverageBuckets are the settings the page's selector offers. The label value
// "all" is the venue's OWN maximum rather than a pooled series: the site
// replaces a selector pinned to "all" with the chosen value, so pinning
// bucket="all" in the spec's queries makes the unfiltered page the max-leverage
// view and every other tab a fixed setting shared across venues.
var leverageBuckets = []struct {
	label string
	lev   float64 // 0 means "the venue's maximum"
}{
	{"all", 0},
	{"10x", 10},
	{"25x", 25},
	{"50x", 50},
	{"100x", 100},
	{"500x", 500},
	{"1000x", 1000},
}

// venueTerms is one venue's parameters on one market, reduced to the model
// above. maintenance returns the requirement as a share of notional at the
// given leverage; it takes the leverage because Gains' threshold interpolates
// with it while the other three are flat.
type venueTerms struct {
	venue       string
	market      string
	maxLev      float64
	maintenance func(lev float64) float64
	forfeitsAll bool
}

func (s *LeverageTermsSource) Fetch() (*SourceResult, error) {
	// Each venue is independent and publishes its own gauges, so a venue that
	// is down costs its own rows and nothing else. The result is empty on
	// purpose: the router's value map is keyed by (venue, metric) and cannot
	// express a per-market, per-leverage figure, so these three gauges are
	// written directly. Nothing here feeds a bench the router serves.
	res := newSourceResult()
	var all []venueTerms
	all = append(all, s.fetchGains()...)
	all = append(all, s.fetchPapertrade()...)
	all = append(all, s.fetchHyperliquid()...)
	all = append(all, s.fetchDydx()...)
	for _, t := range all {
		publishLeverageTerms(t)
	}
	return res, nil
}

// publishLeverageTerms writes one venue's three gauges at every leverage the
// venue allows. A single write path, so the three are always set together: a
// venue that published a max leverage but no room would read as the safest row
// on the board.
func publishLeverageTerms(t venueTerms) {
	for _, b := range leverageBuckets {
		lev := b.lev
		if lev == 0 {
			lev = t.maxLev
		}
		if lev > t.maxLev {
			continue // the venue does not offer this setting
		}
		room, kept, ok := termsAt(t, lev)
		if !ok {
			perpCohortFetchErrors.WithLabelValues(t.venue, srcLeverageTerms, "parse").Inc()
			continue
		}
		perpLeverageMax.WithLabelValues(t.venue, t.market, b.label).Set(t.maxLev)
		perpLiqPriceMovePct.WithLabelValues(t.venue, t.market, b.label).Set(room)
		perpLiqCollateralKeptPct.WithLabelValues(t.venue, t.market, b.label).Set(kept)
		if b.label == "all" {
			fmt.Printf("[perp-cohort][%s][%s] %s at max %.0fx: room=%.4f%% kept=%.1f%%\n",
				t.venue, srcLeverageTerms, t.market, t.maxLev, room, kept)
		}
	}
}

// termsAt is the arithmetic of the model, kept separate from the gauge writes
// so it can be checked against each venue's own worked example.
//
// A position at leverage L posts 1/L of notional and is liquidated when equity
// reaches the maintenance requirement m, so the room is their difference and
// the share returned is m*L. A room at or below zero would describe a position
// liquidated before it opens, which is a unit error rather than a term, so it
// is refused rather than published.
func termsAt(t venueTerms, lev float64) (roomPct, keptPct float64, ok bool) {
	if lev <= 0 || lev > t.maxLev {
		return 0, 0, false
	}
	m := t.maintenance(lev)
	if m <= 0 {
		return 0, 0, false
	}
	room := (1/lev - m) * 100
	if room <= 0 {
		return 0, 0, false
	}
	if t.forfeitsAll {
		return room, 0, true
	}
	return room, m * lev * 100, true
}

// ---------------------------------------------------------------- Gains

func (s *LeverageTermsSource) fetchGains() []venueTerms {
	var out []venueTerms
	for market, idx := range gainsDegenPairs {
		lw, err := s.gainsCall(selPairMaxLev, idx)
		if err != nil || len(lw) < 1 {
			perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, classifyError(fmt.Sprint(err))).Inc()
			fmt.Printf("[perp-cohort][gains][%s] maxLeverage %s: %v\n", srcLeverageTerms, market, err)
			continue
		}
		maxLev := bigToFloat(lw[0], 1e3)
		if maxLev <= 0 {
			continue
		}
		p, err := s.gainsCall(selPairLiqParam, idx)
		if err != nil || len(p) < 5 {
			perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
			fmt.Printf("[perp-cohort][gains][%s] liqParams %s: %v\n", srcLeverageTerms, market, err)
			continue
		}
		startTh := bigToFloat(p[1], 1e10)
		endTh := bigToFloat(p[2], 1e10)
		startLev := bigToFloat(p[3], 1e3)
		endLev := bigToFloat(p[4], 1e3)
		// A threshold at or past the whole collateral is a decode error, not
		// a term: it would describe a position liquidated before it opens.
		if startTh <= 0 || startTh >= 100 || endTh <= 0 || endTh >= 100 {
			perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
			continue
		}
		out = append(out, venueTerms{
			venue:  "gains",
			market: market,
			maxLev: maxLev,
			// The threshold is a share of collateral, so as a share of
			// notional it is the complement divided by the leverage.
			maintenance: func(lev float64) float64 {
				th := interpolateThreshold(startTh, endTh, startLev, endLev, lev)
				return (100 - th) / 100 / lev
			},
		})
	}
	return out
}

// interpolateThreshold mirrors getLiqPnlThresholdP in the gTrade contracts: the
// liquidation threshold is flat below startLeverage, flat above endLeverage,
// and linear between the two. A degen pair sets both bounds to the same value,
// which makes the threshold constant.
func interpolateThreshold(startTh, endTh, startLev, endLev, lev float64) float64 {
	if lev <= startLev {
		return startTh
	}
	if lev >= endLev {
		return endTh
	}
	return startTh - ((lev-startLev)*(startTh-endTh))/(endLev-startLev)
}

func bigToFloat(i *big.Int, scale float64) float64 {
	if i == nil {
		return 0
	}
	f, _ := new(big.Float).Quo(new(big.Float).SetInt(i), big.NewFloat(scale)).Float64()
	return f
}

func (s *LeverageTermsSource) gainsCall(selector string, arg int64) ([]*big.Int, error) {
	data := fmt.Sprintf("%s%064x", selector, arg)
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "eth_call",
		"params": []any{map[string]string{"to": gainsDiamondArb, "data": data}, "latest"},
	})
	req, err := http.NewRequest("POST", gainsArbRPC, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Result string `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("rpc: %s", out.Error.Message)
	}
	return decodeWordsHex(out.Result)
}

func decodeWordsHex(result string) ([]*big.Int, error) {
	h := strings.TrimPrefix(result, "0x")
	if len(h) < 64 || len(h)%64 != 0 {
		return nil, fmt.Errorf("not a whole number of words: %q", result)
	}
	var words []*big.Int
	for i := 0; i+64 <= len(h); i += 64 {
		v, ok := new(big.Int).SetString(h[i:i+64], 16)
		if !ok {
			return nil, fmt.Errorf("bad word at %d", i)
		}
		words = append(words, v)
	}
	return words, nil
}

// ------------------------------------------------------------ Papertrade

func (s *LeverageTermsSource) fetchPapertrade() []venueTerms {
	req, err := http.NewRequest("GET", "https://exchange.papertrade.xyz/state/trading", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, classifyError(err.Error())).Inc()
		return nil
	}
	defer resp.Body.Close()
	var st struct {
		Instruments [][]json.RawMessage `json:"instruments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, "parse").Inc()
		return nil
	}
	var out []venueTerms
	for _, inst := range st.Instruments {
		symbol, lev, buffer, ok := papertradeTerms(inst)
		if !ok {
			perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, "parse").Inc()
			continue
		}
		b := buffer
		out = append(out, venueTerms{
			venue:  "papertrade",
			market: symbol,
			maxLev: lev,
			// Fixed in price, so it does not vary with leverage. That is the
			// whole asymmetry against a collateral-share threshold.
			maintenance: func(float64) float64 { return b },
			// Hard bust: crossing the trigger forfeits the full isolated
			// margin even though a voluntary close a tick earlier would have
			// returned buffer times leverage of it.
			forfeitsAll: true,
		})
	}
	return out
}

// papertradeTerms reads one instrument tuple. The payload is positional, not an
// object: index 1 is the symbol, 14 the max leverage as a plain integer, 16 the
// bust buffer at 1e18 as a decimal string, a share of price. The length guard
// matters more than usual here, because a tuple that grew a field in the middle
// would silently hand back some other number rather than fail.
func papertradeTerms(inst []json.RawMessage) (symbol string, lev, buffer float64, ok bool) {
	if len(inst) < 17 {
		return "", 0, 0, false
	}
	if err := json.Unmarshal(inst[1], &symbol); err != nil || symbol == "" {
		return "", 0, 0, false
	}
	if err := json.Unmarshal(inst[14], &lev); err != nil || lev <= 0 {
		return "", 0, 0, false
	}
	var bufRaw string
	if err := json.Unmarshal(inst[16], &bufRaw); err != nil {
		return "", 0, 0, false
	}
	bi, okBuf := new(big.Int).SetString(bufRaw, 10)
	if !okBuf {
		return "", 0, 0, false
	}
	buffer = bigToFloat(bi, 1e18)
	if buffer <= 0 || buffer >= 1 {
		return "", 0, 0, false
	}
	return symbol, lev, buffer, true
}

// ----------------------------------------------------------- Hyperliquid

// fetchHyperliquid reads maxLeverage per asset from the info `meta` endpoint.
//
// The maintenance requirement is NOT in the payload: Hyperliquid documents it
// as half the initial requirement at maximum leverage, so it is derived rather
// than read. That is a weaker provenance than the other three venues and the
// bench says so in its methodology; it is still the venue's own published rule
// rather than an estimate of ours. It also means the share returned reads 50
// percent at the venue's maximum on every market, by construction.
func (s *LeverageTermsSource) fetchHyperliquid() []venueTerms {
	req, err := http.NewRequest("POST", "https://api.hyperliquid.xyz/info",
		strings.NewReader(`{"type":"meta"}`))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcLeverageTerms, classifyError(err.Error())).Inc()
		return nil
	}
	defer resp.Body.Close()
	var meta struct {
		Universe []struct {
			Name        string  `json:"name"`
			MaxLeverage float64 `json:"maxLeverage"`
			IsDelisted  bool    `json:"isDelisted"`
		} `json:"universe"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcLeverageTerms, "parse").Inc()
		return nil
	}
	var out []venueTerms
	for _, u := range meta.Universe {
		if u.IsDelisted || !leverageTermsMarkets[u.Name] || u.MaxLeverage <= 0 {
			continue
		}
		m := 1 / (2 * u.MaxLeverage)
		out = append(out, venueTerms{
			venue:       "hyperliquid",
			market:      u.Name,
			maxLev:      u.MaxLeverage,
			maintenance: func(float64) float64 { return m },
		})
	}
	return out
}

// ------------------------------------------------------------------ dYdX

// fetchDydx reads initialMarginFraction and maintenanceMarginFraction straight
// off the indexer. Both are published per market, so nothing is derived.
func (s *LeverageTermsSource) fetchDydx() []venueTerms {
	req, err := http.NewRequest("GET", "https://indexer.dydx.trade/v4/perpetualMarkets", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, classifyError(err.Error())).Inc()
		return nil
	}
	defer resp.Body.Close()
	var payload struct {
		Markets map[string]struct {
			Ticker                    string `json:"ticker"`
			Status                    string `json:"status"`
			InitialMarginFraction     string `json:"initialMarginFraction"`
			MaintenanceMarginFraction string `json:"maintenanceMarginFraction"`
		} `json:"markets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, "parse").Inc()
		return nil
	}
	var out []venueTerms
	for _, mk := range payload.Markets {
		base, _, found := strings.Cut(mk.Ticker, "-")
		if !found || !leverageTermsMarkets[base] || mk.Status != "ACTIVE" {
			continue
		}
		initial, err1 := strconv.ParseFloat(mk.InitialMarginFraction, 64)
		maint, err2 := strconv.ParseFloat(mk.MaintenanceMarginFraction, 64)
		if err1 != nil || err2 != nil || initial <= 0 || maint <= 0 || maint >= initial {
			perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, "parse").Inc()
			continue
		}
		m := maint
		out = append(out, venueTerms{
			venue:       "dydx",
			market:      base,
			maxLev:      1 / initial,
			maintenance: func(float64) float64 { return m },
		})
	}
	return out
}
