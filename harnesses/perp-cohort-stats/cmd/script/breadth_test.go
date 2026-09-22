package main

import "testing"

func TestBaseSymbol(t *testing.T) {
	cases := map[string]string{
		"xyz:TSLA":        "TSLA",
		"para:TOTAL2":     "TOTAL2",
		"AAPL-USD-PERP":   "AAPL",
		"TSLA_24_5-USD":   "TSLA",
		"XAUUSDT":         "XAU",
		"XAUUSDC":         "XAU",
		"XAUUSD1":         "XAUUSD1",
		"USDJPY-USD":      "USDJPY",
		"EUR-USD":         "EUR",
		"1000PEPEUSDC":    "1000PEPE",
		"SPX500m-USD":     "SPX500M",
		"PLACE_JPY_1-USD": "PLACE_JPY_1",
	}
	for in, want := range cases {
		if got := baseSymbol(in); got != want {
			t.Errorf("baseSymbol(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSymbolClassHIP3(t *testing.T) {
	core := map[string]bool{"BTC": true, "ETH": true, "HYPE": true}
	cases := map[string]string{
		"xyz:TSLA":    classStocks,
		"xyz:GOLD":    classCommodities,
		"xyz:SILVER":  classCommodities,
		"xyz:CL":      classCommodities,
		"xyz:JPY":     classForex,
		"xyz:EUR":     classForex,
		"xyz:SP500":   classIndices,
		"xyz:XYZ100":  classIndices,
		"xyz:JP225":   classIndices,
		"xyz:EWY":     classStocks, // country ETF: listed equity
		"mkts:US500":  classIndices,
		"mkts:USBOND": classIndices,
		"para:TOTAL2": classCrypto,
		"para:BTCD":   classCrypto,
		"para:10Y":    classIndices,
		"para:AVGO":   classStocks,
		"io:OAI":      classStocks, // pre-IPO synthetic
		"hyna:HYPE":   classCrypto, // core coin relisted on a HIP-3 dex
	}
	for in, want := range cases {
		if got := symbolClass(baseSymbol(in), true, core); got != want {
			t.Errorf("symbolClass(%q) = %q, want %q", in, got, want)
		}
	}
	// Non-RWA venue: an unknown symbol is crypto, only the tables lift it out.
	if got := symbolClass("SPX6900", false, nil); got != classCrypto {
		t.Errorf("SPX6900 on a crypto venue = %q", got)
	}
	if got := symbolClass("XAU", false, nil); got != classCommodities {
		t.Errorf("XAU on a crypto venue = %q", got)
	}
}

func TestRwaClass(t *testing.T) {
	cases := map[string]string{
		"XAU":     classCommodities,
		"NG":      classCommodities,
		"US500":   classIndices,
		"US100":   classIndices,
		"KR200":   classIndices,
		"SPX500M": classIndices,
		"EWY":     classStocks,
		"SOXL":    classStocks,
		"MSFT":    classStocks,
		"XAUUSD1": classCommodities,
		"USDJPY":  classForex,
	}
	for in, want := range cases {
		if got := rwaClass(in); got != want {
			t.Errorf("rwaClass(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestVenueTaxonomies(t *testing.T) {
	if got := extendedClass(extendedMarket{Name: "PAXG-USD", Category: "Crypto", SubCategory: "Commodity"}); got != classCrypto {
		t.Errorf("Extended PAXG = %q, want crypto (tokenized gold is a token)", got)
	}
	if got := extendedClass(extendedMarket{Name: "JP225-USD", Category: "RWA", SubCategory: "ETF/Index"}); got != classIndices {
		t.Errorf("Extended JP225 = %q", got)
	}
	if got := extendedClass(extendedMarket{Name: "OPENAI-USD", Category: "RWA", SubCategory: "Pre-market"}); got != classStocks {
		t.Errorf("Extended OPENAI = %q", got)
	}
	if got := asterClass("XAUUSD1", []string{"USD1-RWA"}); got != classCommodities {
		t.Errorf("Aster XAUUSD1 = %q", got)
	}
	if got := asterClass("SPXUSDT", []string{"ETF"}); got != classIndices {
		t.Errorf("Aster SPXUSDT = %q", got)
	}
	if got := asterClass("AAPLUSDT", []string{"STOCK", "Top"}); got != classStocks {
		t.Errorf("Aster AAPLUSDT = %q", got)
	}
	if got := ondoClass("EWY", []string{"ETF"}); got != classStocks {
		t.Errorf("Ondo EWY ETF = %q", got)
	}
	if got := ondoClass("SPY", []string{"ETF"}); got != classIndices {
		t.Errorf("Ondo SPY ETF = %q, want indices", got)
	}
	if got := ostiumClass("etf", "URA"); got != classStocks {
		t.Errorf("Ostium URA etf = %q", got)
	}
	if got := ostiumClass("etf", "KR2550"); got != classStocks {
		t.Errorf("Ostium KR2550 etf = %q", got)
	}
	if got := gmxNonCrypto["SPCX"]; got != classStocks {
		t.Errorf("GMX SPCX = %q", got)
	}
	if got := symbolClass("WTIOIL", false, nil); got != classCommodities {
		t.Errorf("GMX WTIOIL = %q", got)
	}
	if got := symbolClass("MEGA", false, nil); got != classCrypto {
		t.Errorf("GMX MEGA = %q, want crypto", got)
	}
	if got := dydxNonCrypto["SPX-USD"]; got != "" {
		t.Errorf("dYdX SPX-USD must stay crypto (SPX6900), got %q", got)
	}
}

func TestBreadthCounterNonCore(t *testing.T) {
	b := breadthCounter{classCrypto: 100, classStocks: 40, classForex: 5, classIndices: 3, classCommodities: 2}
	if got := b.nonCore(); got != 50 {
		t.Errorf("nonCore = %d, want 50", got)
	}
	if b.String() != "commodities=2 crypto=100 forex=5 indices=3 stocks=40" {
		t.Errorf("String = %q", b.String())
	}
	var nilCounter breadthCounter
	if nilCounter.clone() != nil {
		t.Error("nil clone must stay nil")
	}
}
