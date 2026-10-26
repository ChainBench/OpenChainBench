package main

import (
	"strconv"
	"time"
)

// BasicSwap, a peer-to-peer atomic-swap order book carried over its own
// message network. Keyless, and the only source measured that lists privacy
// coins nobody else quotes: Firo, PIVX, Wownero and Particl's blind mode
// alongside Monero and Dash.
//
// This is an ORDER BOOK, not a quote rail, and it must never share a
// ranking with Maya, NEAR Intents or THORChain. Those answer "what will
// this swap cost"; a book answers "is there anyone to trade with". Mixing
// them is the mistake that killed two earlier benches here.
//
// The measurement that matters is the MAKER COUNT. Measured on 2026-10-26:
// Monero had 44 distinct makers across 7 pairs, while Dash, Firo, PIVX and
// Particl-blind had exactly ONE each. A row reading "505 DASH offered"
// looks like a market and is one person's standing offer, so the maker
// count is published beside every size rather than left for a footnote.

// privacyCoins is the cohort this board claims. Particl is listed in both
// its transparent and blind forms deliberately: they are the same chain
// with and without the privacy mode, which is a comparison worth having.
var privacyCoins = map[string]bool{
	"XMR": true, "DASH": true, "FIRO": true, "PIVX": true,
	"WOW": true, "PART": true, "PART_BLIND": true, "PART_ANON": true,
}

type bsxOffer struct {
	CoinFrom     string `json:"coin_from"`
	CoinTo       string `json:"coin_to"`
	AmountFromSt string `json:"amount_from_str"`
	AmountToSt   string `json:"amount_to_str"`
	AddrFrom     string `json:"addr_from"`
	BidCount     int    `json:"bid_count"`
	Timestamp    int64  `json:"timestamp"`
	TimeValid    int64  `json:"time_valid"`
}

type bsxBook struct {
	UpdatedAt    string     `json:"updated_at"`
	Timestamp    int64      `json:"timestamp"`
	ActiveOffers int        `json:"active_offers"`
	UniqueMakers int        `json:"unique_makers"`
	Offers       []bsxOffer `json:"offers"`
}

type coinSide struct {
	live   int
	makers map[string]bool
	pairs  map[string]bool
	size   float64
	bids   int
}

// probeBasicSwap reads the book and publishes one row per privacy coin.
//
// Amounts come from the pre-formatted *_str fields on purpose. The raw
// integer amounts are in each coin's own smallest unit, and dividing them
// all by 1e8 produced 2.29 billion Wownero and 15.6 million Monero on the
// first pass. The feed already did the conversion; the decimals problem
// does not need solving, only avoiding.
func probeBasicSwap(cfg *Config) {
	var book bsxBook
	if _, err := getJSON(cfg.BasicSwapURL, &book); err != nil {
		probeTotal.WithLabelValues("basicswap", "order_book", "transport_error").Inc()
		return
	}
	if len(book.Offers) == 0 {
		probeTotal.WithLabelValues("basicswap", "order_book", "empty").Inc()
		return
	}

	now := time.Now().Unix()
	per := map[string]*coinSide{}
	for _, o := range book.Offers {
		// An expired offer is not a market. The feed keeps them in the list,
		// and counting them would let a coin whose last maker left months ago
		// keep a row.
		if o.Timestamp+o.TimeValid <= now {
			continue
		}
		for _, side := range []struct{ coin, amount string }{
			{o.CoinFrom, o.AmountFromSt},
			{o.CoinTo, o.AmountToSt},
		} {
			if !privacyCoins[side.coin] {
				continue
			}
			c := per[side.coin]
			if c == nil {
				c = &coinSide{makers: map[string]bool{}, pairs: map[string]bool{}}
				per[side.coin] = c
			}
			c.live++
			c.makers[o.AddrFrom] = true
			c.pairs[o.CoinFrom+"/"+o.CoinTo] = true
			c.bids += o.BidCount
			if v, err := strconv.ParseFloat(side.amount, 64); err == nil {
				c.size += v
			}
		}
	}

	for coin, c := range per {
		bookMakers.WithLabelValues("basicswap", coin).Set(float64(len(c.makers)))
		bookOffers.WithLabelValues("basicswap", coin).Set(float64(c.live))
		bookPairs.WithLabelValues("basicswap", coin).Set(float64(len(c.pairs)))
		bookSize.WithLabelValues("basicswap", coin).Set(c.size)
	}
	probeTotal.WithLabelValues("basicswap", "order_book", "ok").Inc()
	lastSuccess.WithLabelValues("basicswap", "order_book").Set(float64(time.Now().Unix()))
}
