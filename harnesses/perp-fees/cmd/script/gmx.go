package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

const gmxSubsquid = "https://gmx.squids.live/gmx-synthetics-arbitrum/graphql"
const gmxinfraBase = "https://arbitrum-api.gmxinfra.io"

// GMX v2 market token addresses on Arbitrum mainnet, one market per index
// asset (USDC-collateral main markets). Verified against gmxinfra
// /markets/info (marketToken ↔ indexToken symbol) and the Subsquid
// marketInfos entities.
var gmxMarkets = map[string]string{
	"ETH": "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
	"BTC": "0x47c031236e19d024b42f8AE6780E44A573170703",
	"SOL": "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9",
	// HYPE/USD [WBTC.b-USDC]. GMX lists two HYPE markets and this map takes
	// one address per asset, so the choice was made on the numbers, read on
	// 2026-10-22:
	//
	//   [WBTC.b-USDC]  listed 2025-03-06  OI $541,326  long liquidity $1,633,773
	//   [USDG-USDG]    listed 2026-10-16  OI   $4,626  long liquidity   $151,263
	//
	// 117 times the open interest and 10.8 times the liquidity. The USDG
	// market is six days old and a spread measured there would describe a
	// market nobody uses. It is also the same collateral pair as the BTC
	// market already above, BTC/USD [WBTC.b-USDC], so the pool shape and the
	// USDC short side match what this map already reads.
	//
	// Synthetic: the index token is HYPE while the long collateral is WBTC.b.
	// That shows up in borrowing, which this bench excludes by design
	// (harnesses/perp-fees reads taker fee, spread and impact), not in the
	// taker cost it measures.
	"HYPE": "0xBcb8FE13d02b023e8f94f6881Cc0192fd918A5C0",
}

type gmxGqlReq struct {
	Query     string `json:"query"`
	Variables any    `json:"variables,omitempty"`
}

type gmxMarketInfo struct {
	Data struct {
		MarketInfos []struct {
			ID                                 string `json:"id"`
			PositionFeeFactorForPositiveImpact string `json:"positionFeeFactorForPositiveImpact"`
			PositionFeeFactorForNegativeImpact string `json:"positionFeeFactorForNegativeImpact"`
		} `json:"marketInfos"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

type gmxMarketsRESTItem struct {
	MarketToken     string `json:"marketToken"`
	IndexToken      string `json:"indexToken"`
	IsListed        bool   `json:"isListed"`
	LongToken       string `json:"longToken"`
	ShortToken      string `json:"shortToken"`
	FundingRateLong string `json:"fundingRateLong"`
}

const hoursPerYear = 365 * 24

func (s *PerpSample) setGMXFunding(annualRate string) error {
	if _, ok := new(big.Int).SetString(annualRate, 10); !ok {
		return fmt.Errorf("bad fundingRateLong %q", truncate(annualRate, 80))
	}
	s.FundingRatePerHrBps = factor1e30ToBps(annualRate) / hoursPerYear
	s.HasFunding = true
	return nil
}

type gmxMarketsREST struct {
	Markets []gmxMarketsRESTItem `json:"markets"`
}

const (
	gmxReader            = "0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789"
	gmxDataStore         = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8"
	selGetExecutionPrice = "0x689031a2"
	gmxUSDDecimals       = 30
	gmxExecReplyWords    = 3
)

type gmxPriceRange struct {
	Min *big.Int
	Max *big.Int
}

type gmxMarketPrices struct {
	Index gmxPriceRange
	Long  gmxPriceRange
	Short gmxPriceRange
}

type gmxTicker struct {
	TokenAddress string `json:"tokenAddress"`
	MinPrice     string `json:"minPrice"`
	MaxPrice     string `json:"maxPrice"`
}

func gmxGetJSON(client *http.Client, path string, out any) error {
	resp, err := client.Get(gmxinfraBase + path)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return json.Unmarshal(body, out)
}

type gmxFeeFactors struct {
	PositiveBps float64
	NegativeBps float64
}

func (f gmxFeeFactors) forTrade(balanceWasImproved bool) float64 {
	if balanceWasImproved {
		return f.PositiveBps
	}
	return f.NegativeBps
}

func gmxReadFeeFactors(client *http.Client, market string) (gmxFeeFactors, error) {
	q := gmxGqlReq{
		Query: `query { marketInfos(where: {id_eq: "` + market + `"}) {
			id positionFeeFactorForPositiveImpact positionFeeFactorForNegativeImpact
		}}`,
	}
	respBody, err := postJSON(client, gmxSubsquid, q)
	if err != nil {
		return gmxFeeFactors{}, err
	}
	return gmxFeeFactorsFrom(respBody)
}

func gmxFeeFactorsFrom(respBody []byte) (gmxFeeFactors, error) {
	var info gmxMarketInfo
	if err := json.Unmarshal(respBody, &info); err != nil {
		return gmxFeeFactors{}, fmt.Errorf("parse: %w", err)
	}
	if len(info.Errors) > 0 {
		return gmxFeeFactors{}, fmt.Errorf("gql_error: %s", info.Errors[0].Message)
	}
	if len(info.Data.MarketInfos) == 0 {
		return gmxFeeFactors{}, errors.New("market_not_found")
	}
	m := info.Data.MarketInfos[0]
	fees := gmxFeeFactors{
		PositiveBps: factor1e30ToBps(m.PositionFeeFactorForPositiveImpact),
		NegativeBps: factor1e30ToBps(m.PositionFeeFactorForNegativeImpact),
	}
	if fees.PositiveBps <= 0 || fees.NegativeBps <= 0 {
		return gmxFeeFactors{}, errors.New("zero fee factor")
	}
	return fees, nil
}

func gmxReadMarket(client *http.Client, market string) (gmxMarketsRESTItem, error) {
	var markets gmxMarketsREST
	if err := gmxGetJSON(client, "/markets/info", &markets); err != nil {
		return gmxMarketsRESTItem{}, err
	}
	for _, mk := range markets.Markets {
		if !strings.EqualFold(mk.MarketToken, market) {
			continue
		}
		if !mk.IsListed {
			return gmxMarketsRESTItem{}, errors.New("market delisted")
		}
		return mk, nil
	}
	return gmxMarketsRESTItem{}, errors.New("market not listed")
}

func gmxReadMarketPrices(client *http.Client, m gmxMarketsRESTItem) (gmxMarketPrices, error) {
	var tickers []gmxTicker
	if err := gmxGetJSON(client, "/prices/tickers", &tickers); err != nil {
		return gmxMarketPrices{}, err
	}
	byToken := make(map[string]gmxTicker, len(tickers))
	for _, t := range tickers {
		byToken[strings.ToLower(t.TokenAddress)] = t
	}
	priceOf := func(role, token string) (gmxPriceRange, error) {
		t, ok := byToken[strings.ToLower(token)]
		if !ok {
			return gmxPriceRange{}, fmt.Errorf("no ticker for %s token", role)
		}
		lo, okLo := new(big.Int).SetString(t.MinPrice, 10)
		hi, okHi := new(big.Int).SetString(t.MaxPrice, 10)
		if !okLo || !okHi || lo.Sign() <= 0 || hi.Cmp(lo) < 0 {
			return gmxPriceRange{}, fmt.Errorf("bad ticker for %s token", role)
		}
		return gmxPriceRange{Min: lo, Max: hi}, nil
	}
	var p gmxMarketPrices
	var err error
	if p.Index, err = priceOf("index", m.IndexToken); err != nil {
		return p, err
	}
	if p.Long, err = priceOf("long", m.LongToken); err != nil {
		return p, err
	}
	p.Short, err = priceOf("short", m.ShortToken)
	return p, err
}

func gmxImpactProbe(market string, p gmxMarketPrices, fees gmxFeeFactors) oracleProbe {
	prices := abiUint(p.Index.Min) + abiUint(p.Index.Max) +
		abiUint(p.Long.Min) + abiUint(p.Long.Max) +
		abiUint(p.Short.Min) + abiUint(p.Short.Max)
	head := selGetExecutionPrice + abiAddress(gmxDataStore) + abiAddress(market) + prices +
		abiUint64(0) + abiUint64(0)
	twiceMid := new(big.Int).Add(p.Index.Min, p.Index.Max)
	costBps := func(exec *big.Int) float64 {
		diff := new(big.Int).Sub(new(big.Int).Lsh(exec, 1), twiceMid)
		return ratioFloat(diff, twiceMid) * 1e4
	}
	return oracleProbe{
		CallsFor: func(notional float64) []ethCallMsg {
			size := abiUint(usdScaled(notional, gmxUSDDecimals))
			call := func(long bool) ethCallMsg {
				return ethCallMsg{To: gmxReader, Data: head + size + abiUint64(0) + abiBool(long)}
			}
			return []ethCallMsg{call(true), call(false)}
		},
		CostFrom: func(r []string) (sideCosts, error) {
			for _, res := range r {
				if len(strings.TrimPrefix(res, "0x")) < gmxExecReplyWords*abiWordHexLen {
					return sideCosts{}, fmt.Errorf("execution price reply of %d hex chars", len(res))
				}
			}
			long, short := uint256ArgAt(r[0], 1), uint256ArgAt(r[1], 1)
			if long.Sign() <= 0 || short.Sign() <= 0 {
				return sideCosts{}, errors.New("zero execution price")
			}
			improved := func(i int) bool { return uint256ArgAt(r[i], 2).Sign() != 0 }
			return sideCosts{
				Long:     costBps(long),
				Short:    -costBps(short),
				LongFee:  fees.forTrade(improved(0)),
				ShortFee: fees.forTrade(improved(1)),
			}, nil
		},
	}
}

func fetchGMX(v VenueConfig, rpcURL string) (s PerpSample) {
	s = PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}
	defer func() { s.FetchLatencyMs = time.Since(start).Milliseconds() }()

	market, ok := gmxMarkets[v.Asset]
	if !ok {
		s.Err = "unsupported_asset"
		return s
	}
	fees, err := gmxReadFeeFactors(client, market)
	if err != nil {
		s.Err = fmt.Sprintf("subsquid_failed: %v", err)
		return s
	}

	info, err := gmxReadMarket(client, market)
	if err != nil {
		s.Err = fmt.Sprintf("markets_info: %v", err)
		return s
	}
	if err := s.setGMXFunding(info.FundingRateLong); err != nil {
		s.Err = fmt.Sprintf("markets_info: %v", err)
		return s
	}

	prices, err := gmxReadMarketPrices(client, info)
	if err != nil {
		s.Err = fmt.Sprintf("tickers: %v", err)
		return s
	}
	probe := gmxImpactProbe(market, prices, fees)
	quotes, err := quoteOracle(client, rpcURL, oracleNotionals(v.NotionalUSD), probe)
	if err != nil {
		s.Err = fmt.Sprintf("price_impact: %v", err)
		return s
	}
	applyOracleQuotes(&s, v.NotionalUSD, quotes)
	return s
}

// factor1e30ToBps turns a string like "600000000000000000000000000"
// (6e26 = 0.0006) into the equivalent in basis points (6).
func factor1e30ToBps(raw string) float64 {
	if raw == "" {
		return 0
	}
	bi := new(big.Int)
	if _, ok := bi.SetString(raw, 10); !ok {
		return 0
	}
	// Convert to float via division: bi / 1e30 then × 10000 → bi / 1e26
	// Use big.Float for precision.
	f := new(big.Float).SetInt(bi)
	denom := new(big.Float).SetInt64(1)
	for i := 0; i < 26; i++ {
		denom = new(big.Float).Mul(denom, big.NewFloat(10))
	}
	f = new(big.Float).Quo(f, denom)
	out, _ := f.Float64()
	return out
}
