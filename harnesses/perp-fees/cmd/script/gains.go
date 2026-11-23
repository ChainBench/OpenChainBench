package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

const gainsDiamond = "0xFF162c694eAA571f685030649814282eA457f169"

const selPairs = "0xb91ac788"      // pairs(uint256)
const selFees = "0x4acc79ed"       // fees(uint256)
const selPairsCount = "0x88c64eb8" // pairsCount()

// extractAsciiString reads a dynamic string at byte offset `byteOffset`
// (relative to the start of the result data, after the leading 0x20).
func extractAsciiString(result string, byteOffset int64) string {
	hexStr := strings.TrimPrefix(result, "0x")
	hdrStart := int(byteOffset) * 2
	if hdrStart+64 > len(hexStr) {
		return ""
	}
	strLen := new(big.Int)
	strLen.SetString(hexStr[hdrStart:hdrStart+64], 16)
	dataStart := hdrStart + 64
	dataEnd := dataStart + int(strLen.Int64())*2
	if dataEnd > len(hexStr) {
		return ""
	}
	bs, err := hex.DecodeString(hexStr[dataStart:dataEnd])
	if err != nil {
		return ""
	}
	return string(bs)
}

type gainsPair struct {
	Index    int
	From     string
	To       string
	SpreadP  *big.Int
	FeeIndex int64
}

func gainsReadPair(client *http.Client, rpcURL string, pairIndex int) (*gainsPair, error) {
	idx := fmt.Sprintf("%064x", pairIndex)
	res, err := ethCall(client, rpcURL, gainsDiamond, selPairs+idx)
	if err != nil {
		return nil, err
	}
	fromOff := uint256ArgAt(res, 1).Int64()
	toOff := uint256ArgAt(res, 2).Int64()
	// First slot of result is 0x20 pointing past it; offsets are relative
	// to the start of the struct content.
	from := extractAsciiString(res, fromOff+32)
	to := extractAsciiString(res, toOff+32)
	// Pair struct slot layout (re-verified against the Gains backend
	// /trading-variables on 2026-07-08):
	//   slot 7 → spreadP    (full bid-ask spread, 1e10 precision)
	//   slot 8 → groupIndex
	//   slot 9 → feeIndex   (the fees(N) tier; ETH and BTC use 13, SOL 11)
	// Reading slot 9 + applying half-spread (/2) matches the backend values
	// exactly (ETH/BTC spreadP=1e8, SOL spreadP=0).
	return &gainsPair{
		Index:    pairIndex,
		From:     from,
		To:       to,
		SpreadP:  uint256ArgAt(res, 7),
		FeeIndex: uint256ArgAt(res, 9).Int64(),
	}, nil
}

func gainsReadFeeOpenP(client *http.Client, rpcURL string, feeIndex int64) (*big.Int, error) {
	idx := fmt.Sprintf("%064x", feeIndex)
	res, err := ethCall(client, rpcURL, gainsDiamond, selFees+idx)
	if err != nil {
		return nil, err
	}
	return uint256ArgAt(res, 0), nil
}

var (
	gainsPairCache    = map[string]*gainsPair{} // by uppercase asset name
	gainsPairIdxCache = map[string]int{}        // by uppercase asset name
	gainsPairAt       = map[string]time.Time{}  // last on-chain read per asset
	gainsFeeCache     = map[int64]gainsFeeEntry{}
	gainsCacheMu      sync.Mutex
)

// Pair config (spreadP, feeIndex) changes only by governance, but caching it
// forever would freeze the published spread until a process restart. Re-read
// the known pair index every TTL so config changes surface within hours.
const gainsPairTTL = 6 * time.Hour

type gainsFeeEntry struct {
	openFeeP *big.Int
	at       time.Time
}

// findGainsPair scans pair indices for a (asset, USD) match. Caches the
// full Pair object — every pair seen during the scan gets cached, so
// running the scan once populates BTC, ETH, LTC, etc. all at once and
// future calls hit the cache directly.
func findGainsPair(client *http.Client, rpcURL, asset string) (*gainsPair, error) {
	upper := strings.ToUpper(asset)

	gainsCacheMu.Lock()
	cached, ok := gainsPairCache[upper]
	fresh := ok && time.Since(gainsPairAt[upper]) < gainsPairTTL
	idx, hasIdx := gainsPairIdxCache[upper]
	gainsCacheMu.Unlock()
	if fresh {
		return cached, nil
	}

	// Known index, stale cache: re-read that single pair instead of a full
	// scan. On failure we return the error so the cycle skips publishing
	// (visible via fetch_errors_total) rather than silently reusing config
	// that may have changed on-chain.
	if ok && hasIdx {
		p, err := gainsReadPair(client, rpcURL, idx)
		if err != nil {
			return nil, fmt.Errorf("refresh pair %d: %w", idx, err)
		}
		if !strings.EqualFold(p.From, asset) || !strings.EqualFold(p.To, "USD") {
			return nil, fmt.Errorf("pair %d is now %s/%s, expected %s/USD", idx, p.From, p.To, asset)
		}
		gainsCacheMu.Lock()
		gainsPairCache[upper] = p
		gainsPairAt[upper] = time.Now()
		gainsCacheMu.Unlock()
		return p, nil
	}

	gainsScanMu.Lock()
	defer gainsScanMu.Unlock()

	// Re-check after acquiring the scan lock — another goroutine may have
	// just populated the cache while we waited.
	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok && time.Since(gainsPairAt[upper]) < gainsPairTTL {
		gainsCacheMu.Unlock()
		return p, nil
	}
	gainsCacheMu.Unlock()

	// Gains v8 has grown well past 60 pairs; a narrow scan silently misses
	// USD-quoted pairs (SOL/USD sits past the first crypto majors) and lets
	// a same-symbol non-USD pair win the cache slot. 200 is enough headroom
	// for the current listed universe with the 3-consecutive-errors early
	// exit still handling the tail.
	consecutiveErrors := 0
	for i := 0; i < 200; i++ {
		p, err := gainsReadPair(client, rpcURL, i)
		if err != nil {
			fmt.Printf("[PERP][gains] pair scan idx %d: %v\n", i, err)
			consecutiveErrors++
			if consecutiveErrors >= 3 && i > 5 {
				break
			}
			continue
		}
		consecutiveErrors = 0
		if p.From == "" {
			continue
		}
		// Only cache USD-quoted pairs. Gains lists cross pairs like SOL/BTC
		// alongside SOL/USD, and keying the cache by From alone would let a
		// non-USD pair (with a different feeIndex/spreadP) win the slot for
		// an asset that also has a USD pair. That was the source of the
		// uniform-4.333-bps SOL bug: SOL's non-USD pair pinned the cache to
		// a crypto-major feeIndex before SOL/USD was reached in the scan.
		if !strings.EqualFold(p.To, "USD") {
			continue
		}
		gainsCacheMu.Lock()
		gainsPairCache[strings.ToUpper(p.From)] = p
		gainsPairIdxCache[strings.ToUpper(p.From)] = i
		gainsPairAt[strings.ToUpper(p.From)] = time.Now()
		gainsCacheMu.Unlock()
		if strings.EqualFold(p.From, asset) {
			return p, nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok && strings.EqualFold(p.To, "USD") {
		gainsCacheMu.Unlock()
		return p, nil
	}
	gainsCacheMu.Unlock()
	return nil, fmt.Errorf("no pair for %s/USD", asset)
}

var gainsScanMu sync.Mutex

func fetchGains(v VenueConfig, rpcURL string) (s PerpSample) {
	s = PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}
	defer func() { s.FetchLatencyMs = time.Since(start).Milliseconds() }()

	pair, err := findGainsPair(client, rpcURL, v.Asset)
	if err != nil {
		s.Err = fmt.Sprintf("find_pair: %v", err)
		return s
	}

	// Cache the openFeeP for 1h. Gains fee tiers change rarely (governance
	// vote) so polling more often just burns RPC quota. Holding the mutex
	// across the RPC call deduplicates concurrent fetches that share a
	// feeIndex (ETH and BTC both use feeIndex 13, SOL uses 11).
	gainsCacheMu.Lock()
	cached, ok := gainsFeeCache[pair.FeeIndex]
	var openFeeP *big.Int
	if ok && time.Since(cached.at) < time.Hour {
		openFeeP = cached.openFeeP
		gainsCacheMu.Unlock()
	} else {
		openFeeP, err = gainsReadFeeOpenP(client, rpcURL, pair.FeeIndex)
		if err == nil && openFeeP.Sign() <= 0 {
			err = errors.New("zero open fee")
		}
		if err != nil {
			gainsCacheMu.Unlock()
			s.Err = fmt.Sprintf("read_fee: %v", err)
			return s
		}
		gainsFeeCache[pair.FeeIndex] = gainsFeeEntry{openFeeP: openFeeP, at: time.Now()}
		gainsCacheMu.Unlock()
	}

	feeBps := gainsPToBps(openFeeP)
	halfSpreadBps := gainsPToBps(pair.SpreadP) / 2

	var quotes map[float64]oracleQuote
	err = withGainsRPCGap(func() error {
		price, err := gainsReadPrice(client, rpcURL, v.Asset)
		if err != nil {
			return fmt.Errorf("read_price: %w", err)
		}
		s.MidPrice = ratioFloat(price, chainlinkPriceScale)
		probe := gainsImpactProbe(pair.Index, halfSpreadBps, feeBps)
		quotes, err = quoteOracle(client, rpcURL, oracleNotionals(v.NotionalUSD), probe)
		if err != nil {
			return fmt.Errorf("price_impact: %w", err)
		}
		return nil
	})
	if err != nil {
		s.Err = err.Error()
		return s
	}
	applyOracleQuotes(&s, v.NotionalUSD, quotes)
	return s
}

const (
	selLatestRoundData = "0xfeaf968c"
	selCumulVolImpactP = "0x6901d442"
	gainsPPerBps       = 1e8
	gainsTokenDecimals = 18
)

var chainlinkPriceScale = big.NewInt(1e8)

var gainsChainlinkFeeds = map[string]string{
	"ETH": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
	"BTC": "0x6ce185860a4963106506C203335A2910413708e9",
	"SOL": "0x24ceA4b8ce57cda5058b924B9B9987992450590c",
}

const gainsBatchGap = time.Second

var (
	gainsBatchMu sync.Mutex
	gainsBatchAt time.Time
)

func withGainsRPCGap(read func() error) error {
	gainsBatchMu.Lock()
	defer gainsBatchMu.Unlock()
	if wait := gainsBatchGap - time.Since(gainsBatchAt); wait > 0 {
		time.Sleep(wait)
	}
	defer func() { gainsBatchAt = time.Now() }()
	return read()
}

func gainsPToBps(p *big.Int) float64 {
	return ratioFloat(p, big.NewInt(gainsPPerBps))
}

func gainsReadPrice(client *http.Client, rpcURL, asset string) (*big.Int, error) {
	feed, ok := gainsChainlinkFeeds[strings.ToUpper(asset)]
	if !ok {
		return nil, fmt.Errorf("no price feed for %s", asset)
	}
	res, err := ethCall(client, rpcURL, feed, selLatestRoundData)
	if err != nil {
		return nil, err
	}
	answer := int256ArgAt(res, 1)
	if answer.Sign() <= 0 {
		return nil, errors.New("non-positive oracle price")
	}
	return answer, nil
}

func gainsImpactProbe(pairIndex int, halfSpreadBps, feeBps float64) oracleProbe {
	idx := abiUint(big.NewInt(int64(pairIndex)))
	return oracleProbe{
		CallsFor: func(notional float64) []ethCallMsg {
			usd := usdScaled(notional, gainsTokenDecimals)
			cumul := func(long bool) ethCallMsg {
				return ethCallMsg{To: gainsDiamond, Data: selCumulVolImpactP +
					abiAddress("0x0") + idx + abiBool(long) + abiUint(usd) +
					abiBool(false) + abiBool(true) + abiUint64(0)}
			}
			return []ethCallMsg{cumul(true), cumul(false)}
		},
		CostFrom: func(r []string) (sideCosts, error) {
			for _, res := range r {
				if len(strings.TrimPrefix(res, "0x")) != abiWordHexLen {
					return sideCosts{}, fmt.Errorf("impact reply of %d hex chars", len(res))
				}
			}
			impact := func(i int) float64 { return gainsPToBps(int256ArgAt(r[i], 0)) }
			return sideCosts{
				Long:     halfSpreadBps + impact(0),
				Short:    halfSpreadBps - impact(1),
				LongFee:  feeBps,
				ShortFee: feeBps,
			}, nil
		},
	}
}
