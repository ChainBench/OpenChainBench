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

// coinSlug is the cohort this board claims, mapping the feed's own symbol
// to the row slug on the board.
//
// The label value has to BE the slug. A metric panel is queried as
// `<metric>{coin="<provider slug>"}`, built from the spec's provider list
// with no normalisation, so a gauge labelled "XMR" is invisible to a row
// called "xmr" and the panel renders empty with no error anywhere. That is
// how this board shipped with both of its companion columns blank while the
// subtitle promised "the offers and pairs behind the count".
//
// Particl is listed in both its transparent and blind forms deliberately:
// they are the same chain with and without the privacy mode, which is a
// comparison worth having.
var coinSlug = map[string]string{
	"XMR":        "xmr",
	"DASH":       "dash",
	"FIRO":       "firo",
	"PIVX":       "pivx",
	"WOW":        "wow",
	"PART":       "part",
	"PART_BLIND": "part-blind",
	"PART_ANON":  "part-anon",
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

func newCoinSide() *coinSide {
	return &coinSide{makers: map[string]bool{}, pairs: map[string]bool{}}
}

// marketKey names a market without a direction. The feed carries an offer as
// an ordered (from, to) pair, so XMR->BTC and BTC->XMR are two entries for
// one market. Keying on the ordered pair published 8 "distinct pairs" for
// Monero on 2026-10-27 where the book held 5 markets, and over-counted Dash
// and Wownero the same way.
func marketKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "/" + b
}

// foldBook reduces the raw offer list to one entry per coin in the cohort.
//
// Every coin is present in the result, including the ones with nothing on
// the book, because the caller publishes what this returns and a Prometheus
// gauge that is simply not Set keeps its last value for as long as the
// process lives. Skipping an empty coin republishes the market it used to
// have: Firo sat at one maker for a full day on 2026-10-27 with zero Firo
// offers anywhere in the feed, which is the exact row this bench exists to
// refuse.
func foldBook(offers []bsxOffer, now int64) map[string]*coinSide {
	per := map[string]*coinSide{}
	for _, slug := range coinSlug {
		per[slug] = newCoinSide()
	}
	for _, o := range offers {
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
			slug, ok := coinSlug[side.coin]
			if !ok {
				continue
			}
			c := per[slug]
			c.live++
			c.makers[o.AddrFrom] = true
			c.pairs[marketKey(o.CoinFrom, o.CoinTo)] = true
			c.bids += o.BidCount
			if v, err := strconv.ParseFloat(side.amount, 64); err == nil {
				c.size += v
			}
		}
	}
	return per
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
	// An empty list is a feed failure, not an empty market, and publishing
	// zeros from it would wipe every row on one bad read.
	if len(book.Offers) == 0 {
		probeTotal.WithLabelValues("basicswap", "order_book", "empty").Inc()
		return
	}

	for slug, c := range foldBook(book.Offers, time.Now().Unix()) {
		bookMakers.WithLabelValues("basicswap", slug).Set(float64(len(c.makers)))
		bookOffers.WithLabelValues("basicswap", slug).Set(float64(c.live))
		bookPairs.WithLabelValues("basicswap", slug).Set(float64(len(c.pairs)))
		bookSize.WithLabelValues("basicswap", slug).Set(c.size)
	}
	probeTotal.WithLabelValues("basicswap", "order_book", "ok").Inc()
	lastSuccess.WithLabelValues("basicswap", "order_book").Set(float64(time.Now().Unix()))
}
