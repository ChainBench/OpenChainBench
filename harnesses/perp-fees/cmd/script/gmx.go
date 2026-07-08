package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"time"
)

// GMX v2 on Arbitrum: position fee from Subsquid GraphQL, funding/borrowing
// from gmxinfra REST. No orderbook (oracle-priced) — slippage component is
// the on-chain priceImpact, computed from impactFactor × imbalance. For
// $1k notional the imbalance term is negligible, so we report just the
// negative-impact branch fee (worst-case opening cost).

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
}

type gmxGqlReq struct {
	Query     string `json:"query"`
	Variables any    `json:"variables,omitempty"`
}

type gmxMarketInfo struct {
	Data struct {
		MarketInfos []struct {
			ID                                       string `json:"id"`
			PositionFeeFactorForPositiveImpact       string `json:"positionFeeFactorForPositiveImpact"`
			PositionFeeFactorForNegativeImpact       string `json:"positionFeeFactorForNegativeImpact"`
		} `json:"marketInfos"`
	} `json:"data"`
}

type gmxMarketsRESTItem struct {
	MarketToken         string `json:"marketToken"`
	IndexToken          string `json:"indexToken"`
	FundingFactorPerSecondLong  string `json:"fundingFactorPerSecondLong"`
	FundingFactorPerSecondShort string `json:"fundingFactorPerSecondShort"`
	BorrowingFactorPerSecondForLongs  string `json:"borrowingFactorPerSecondForLongs"`
	BorrowingFactorPerSecondForShorts string `json:"borrowingFactorPerSecondForShorts"`
}

type gmxMarketsREST struct {
	Markets []gmxMarketsRESTItem `json:"markets"`
}

func fetchGMX(v VenueConfig) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}

	market, ok := gmxMarkets[v.Asset]
	if !ok {
		s.Err = "unsupported_asset"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// 1) Position fee from Subsquid (live on-chain factor)
	q := gmxGqlReq{
		Query: `query { marketInfos(where: {id_eq: "` + market + `"}) {
			id positionFeeFactorForPositiveImpact positionFeeFactorForNegativeImpact
		}}`,
	}
	bodyBytes, _ := json.Marshal(q)
	req, _ := http.NewRequest("POST", gmxSubsquid, bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		s.Err = fmt.Sprintf("gql: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		s.Err = fmt.Sprintf("gql_status_%d: %s", resp.StatusCode, truncate(string(respBody), 200))
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	var info gmxMarketInfo
	if err := json.Unmarshal(respBody, &info); err != nil {
		s.Err = fmt.Sprintf("gql_parse: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if len(info.Data.MarketInfos) == 0 {
		s.Err = "market_not_found"
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	m := info.Data.MarketInfos[0]
	// FLOAT_PRECISION = 1e30. positionFeeFactor = factor * 1e30.
	// e.g. "600000000000000000000000000" = 0.0006 = 6 bps.
	negativeFee := factor1e30ToBps(m.PositionFeeFactorForNegativeImpact)
	s.TakerFeeBps = negativeFee
	// On GMX there's no orderbook spread — slippage = priceImpact, which
	// is ~0 for $1k notional vs. multi-million pool TVL.
	s.SpreadBps = 0

	// 2) Funding rate from gmxinfra REST
	var markets gmxMarketsREST
	resp2, err := client.Get(gmxinfraBase + "/markets/info")
	if err == nil {
		defer resp2.Body.Close()
		body2, _ := io.ReadAll(resp2.Body)
		_ = json.Unmarshal(body2, &markets)
		for _, mk := range markets.Markets {
			if mk.MarketToken == market {
				// fundingFactorPerSecondLong scaled by 1e30. Convert to per-hour bps.
				perSec := factor1e30ToBps(mk.FundingFactorPerSecondLong)
				s.FundingRatePerHrBps = perSec * 3600
				break
			}
		}
	}

	s.AllInBps = s.TakerFeeBps + s.SpreadBps
	s.FetchLatencyMs = time.Since(start).Milliseconds()
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

// silence unused import warning if needed
var _ = strconv.Itoa
