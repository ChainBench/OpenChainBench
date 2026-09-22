package main

import (
	"fmt"
	"sort"
	"strings"
)

// Asset-class breadth. Every native source that sees a venue's market
// list buckets it into five classes and hands the counts to the router
// through SourceResult.Breadth; the router publishes
// perp_venue_markets_by_class{venue,class} and
// perp_venue_noncore_markets_total{venue} (bench perp-asset-breadth).
//
// Class names match the Mobula perp catalog taxonomy the bench started
// with (Gains and Lighter still come from Mobula), so a Mobula row and a
// native row are comparable:
//
//	crypto       tokens and crypto indices (TOTAL2, BTC dominance)
//	forex        fiat pairs (EUR/USD, USD/JPY)
//	stocks       listed equities, ADRs, sector and country ETFs, pre-IPO synthetics
//	indices      equity and rates indices (S&P 500, Nasdaq 100, KOSPI 200) and
//	             the ETFs that track one (SPY, QQQ, IWM)
//	commodities  metals and energy on their spot or futures reference
//
// Tokenized gold (PAXG, XAUT) is a crypto token and stays in crypto; the
// venues that tag it (Extended, Paradex) do the same. Only the venue's
// own metadata decides when it exists (Extended category, Paradex tags,
// Aster underlyingSubType, Ostium group, Ondo tags); the symbol tables
// below only split a venue-tagged RWA bucket into forex, indices and
// commodities, and cover the two venues with no metadata at all
// (Hyperliquid HIP-3 dexes, dYdX).
const (
	classCrypto      = "crypto"
	classForex       = "forex"
	classStocks      = "stocks"
	classIndices     = "indices"
	classCommodities = "commodities"
)

var breadthClasses = []string{classCrypto, classForex, classStocks, classIndices, classCommodities}

var nonCoreClasses = map[string]bool{classForex: true, classStocks: true, classIndices: true, classCommodities: true}

// Symbol tables. Symbols are compared upper-cased, after the venue prefix
// (`xyz:`) and quote suffix (`-USD`, `USDT`, `USDC`, `-USD-PERP`) are
// stripped by the caller through baseSymbol.
var forexSymbols = symbolSet(
	"EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD", "CNH", "CNY", "MXN", "HKD", "TRY",
	"SEK", "NOK", "SGD", "KRW", "INR", "BRL", "ZAR", "PLN",
	"EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "USDJPY", "USDCAD", "USDCHF", "USDMXN", "USDHKD",
	"USDCNH", "USDTRY", "USDKRW", "PLACE_JPY", "PLACE_JPY_1",
)

var commoditySymbols = symbolSet(
	"XAU", "GOLD", "XAG", "SILVER", "XPT", "PLATINUM", "XPD", "PALLADIUM",
	"HG", "COPPER", "XCU", "CL", "WTI", "WTIOIL", "USOIL", "BRENT", "BRENTOIL", "BZ", "XBR",
	"NG", "NATGAS", "XNG", "XAUUSD1", "XAGUSD1",
)

var indexSymbols = symbolSet(
	"SPX", "SP500", "SPX500", "SPX500M", "US500", "ES", "SPY",
	"NDX", "US100", "USTECH", "TECH100", "TECH100M", "NAS100", "QQQ", "XYZ100",
	"DJI", "US30", "DAX", "GER40", "FTSE", "UK100", "NIK", "NIKKEI", "JP225",
	"HSI", "HK50", "KR200", "KOSPI", "KOSPI200", "KODEX200", "SMALL2000", "US2000", "RUSSELL", "RUT", "IWM",
	"VIX", "10Y", "USBOND", "USTBOND", "US10Y",
)

// Crypto indices published by HIP-3 deployers: crypto, not RWA.
var cryptoIndexSymbols = symbolSet("TOTAL2", "TOTAL3", "OTHERS", "BTCD", "BTC.D", "ETHD")

func symbolSet(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, s := range items {
		m[strings.ToUpper(s)] = true
	}
	return m
}

// baseSymbol strips a venue prefix (`xyz:TSLA`), a quote suffix
// (`AAPL-USD`, `AAPLUSDT`, `AAPL-USD-PERP`, `XAUUSDC`) and Extended's
// session marker (`TSLA_24_5`), and upper-cases the result.
func baseSymbol(market string) string {
	s := strings.ToUpper(strings.TrimSpace(market))
	if i := strings.LastIndex(s, ":"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.TrimSuffix(s, "-PERP")
	for _, q := range []string{"-USD", "-USDC", "-USDT", "USDT", "USDC"} {
		if strings.HasSuffix(s, q) && len(s) > len(q) {
			s = strings.TrimSuffix(s, q)
			break
		}
	}
	s = strings.TrimSuffix(s, "_24_5")
	return s
}

// rwaClass splits a symbol the venue already flagged as non-crypto into
// forex, indices or commodities; anything else is an equity, ADR, ETF or
// pre-IPO synthetic and counts as stocks.
func rwaClass(base string) string {
	switch {
	case forexSymbols[base]:
		return classForex
	case commoditySymbols[base]:
		return classCommodities
	case indexSymbols[base]:
		return classIndices
	}
	return classStocks
}

// symbolClass is the no-metadata path (Hyperliquid HIP-3 dexes, dYdX):
// a symbol is non-crypto only when it sits in one of the explicit
// tables or when the caller says the listing venue is an RWA dex.
func symbolClass(base string, rwaVenue bool, knownCrypto map[string]bool) string {
	switch {
	case cryptoIndexSymbols[base], knownCrypto[base]:
		return classCrypto
	case forexSymbols[base]:
		return classForex
	case commoditySymbols[base]:
		return classCommodities
	case indexSymbols[base]:
		return classIndices
	case rwaVenue:
		return classStocks
	}
	return classCrypto
}

// breadthCounter accumulates one venue's class counts.
type breadthCounter map[string]int

func (b breadthCounter) add(class string) { b[class]++ }

// clone returns an independent copy; nil stays nil so a cache miss
// reads as "nothing to publish".
func (b breadthCounter) clone() breadthCounter {
	if b == nil {
		return nil
	}
	c := make(breadthCounter, len(b))
	for k, v := range b {
		c[k] = v
	}
	return c
}

func (b breadthCounter) nonCore() int {
	n := 0
	for class, c := range b {
		if nonCoreClasses[class] {
			n += c
		}
	}
	return n
}

func (b breadthCounter) String() string {
	keys := make([]string, 0, len(b))
	for k := range b {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, b[k]))
	}
	return strings.Join(parts, " ")
}

// SetBreadth records a venue's class counts. A source only calls it
// when it saw the venue's full market list this tick; an empty or
// partial list must not be recorded (the router keeps the previous
// gauge values when no source reports the venue).
func (r *SourceResult) SetBreadth(venue string, b breadthCounter) {
	if len(b) == 0 {
		return
	}
	if r.Breadth == nil {
		r.Breadth = map[string]map[string]int{}
	}
	m := make(map[string]int, len(b))
	for k, v := range b {
		m[k] = v
	}
	r.Breadth[venue] = m
}

// publishBreadth writes the class gauges for one venue. Every class is
// written, zero included, so a venue that delists its last forex pair
// drops to 0 instead of freezing at the old count.
func publishBreadth(venue string, counts map[string]int) {
	total := 0
	for _, class := range breadthClasses {
		n := counts[class]
		perpVenueMarketsByClass.WithLabelValues(venue, class).Set(float64(n))
		if nonCoreClasses[class] {
			total += n
		}
	}
	perpVenueNoncoreMarketsTotal.WithLabelValues(venue).Set(float64(total))
}
