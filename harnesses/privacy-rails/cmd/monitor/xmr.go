package main

import (
	"encoding/json"
	"sort"
	"strconv"
	"time"
)

// Bitcoin to Monero atomic swaps, through the UnstoppableSwap maker
// directory. Keyless, 238 ms when measured on 2026-10-25, and the only live
// non-custodial Monero rail found: Monero is absent from NEAR Intents (205
// tokens), Chainflip, Sideshift and Maya.
//
// This is an over-the-counter maker book, not a quote rail, and it must
// never share a ranking with the Maya and NEAR boards. A maker book's
// question is dispersion and availability; a rail's question is cost. Mixing
// them would be the mistake that killed two earlier benches here: one
// ranking over venues that do not answer the same question.

type xmrMaker struct {
	PeerID        string      `json:"peerId"`
	Price         json.Number `json:"price"`
	MinSwapAmount json.Number `json:"minSwapAmount"`
	MaxSwapAmount json.Number `json:"maxSwapAmount"`
	Testnet       bool        `json:"testnet"`
	Recommended   bool        `json:"recommended"`
	Age           json.Number `json:"age"`
}

func num(n json.Number) (float64, bool) {
	if n.String() == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(n.String(), 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	return v, true
}

// probeXmr publishes four numbers about the book, and refuses to publish a
// dispersion from fewer than two makers: a one-maker book has a spread of
// zero by arithmetic, which would read as a perfect market.
func probeXmr(cfg *Config) {
	var makers []xmrMaker
	if _, err := getJSON(cfg.XmrListURL, &makers); err != nil {
		probeTotal.WithLabelValues("unstoppableswap", "maker_book", "transport_error").Inc()
		return
	}

	var prices []float64
	var mins, maxs []float64
	live := 0
	for _, m := range makers {
		if m.Testnet {
			continue // a testnet maker quotes play money
		}
		live++
		if p, ok := num(m.Price); ok {
			prices = append(prices, p)
		}
		if v, ok := num(m.MinSwapAmount); ok {
			mins = append(mins, v)
		}
		if v, ok := num(m.MaxSwapAmount); ok {
			maxs = append(maxs, v)
		}
	}

	bookMakers.WithLabelValues("unstoppableswap", "XMR").Set(float64(live))
	bookOffers.WithLabelValues("unstoppableswap", "XMR").Set(float64(live))
	if live == 0 {
		probeTotal.WithLabelValues("unstoppableswap", "maker_book", "empty").Inc()
		return
	}

	if len(prices) >= 2 {
		sort.Float64s(prices)
		med := prices[len(prices)/2]
		if med > 0 {
			bookDispersion.WithLabelValues("unstoppableswap", "XMR").Set((prices[len(prices)-1] - prices[0]) / med * 100)
		}
		// "Best" for a buyer of XMR is the lowest satoshi-per-XMR price.
		bookBestPrice.WithLabelValues("unstoppableswap", "XMR").Set(prices[0])
	} else {
		probeTotal.WithLabelValues("unstoppableswap", "maker_book", "too_few_for_dispersion").Inc()
	}
	if len(mins) > 0 {
		sort.Float64s(mins)
		bookMinSize.WithLabelValues("unstoppableswap", "XMR").Set(mins[0])
	}
	if len(maxs) > 0 {
		sort.Float64s(maxs)
		bookMaxSize.WithLabelValues("unstoppableswap", "XMR").Set(maxs[len(maxs)-1])
	}
	probeTotal.WithLabelValues("unstoppableswap", "maker_book", "ok").Inc()
	lastSuccess.WithLabelValues("unstoppableswap", "maker_book").Set(float64(time.Now().Unix()))
}
