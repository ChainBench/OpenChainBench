package main

import "testing"

// The three things foldBook has to get right, each one a number this board
// published wrong before the fold existed.

func TestMarketKeyIgnoresDirection(t *testing.T) {
	if marketKey("XMR", "BTC") != marketKey("BTC", "XMR") {
		t.Fatalf("XMR/BTC and BTC/XMR must be one market, got %q and %q",
			marketKey("XMR", "BTC"), marketKey("BTC", "XMR"))
	}
}

func TestReciprocalOffersAreOneMarket(t *testing.T) {
	now := int64(1_000_000)
	offers := []bsxOffer{
		{CoinFrom: "XMR", CoinTo: "BTC", AddrFrom: "a", Timestamp: now, TimeValid: 3600,
			AmountFromSt: "1.5", AmountToSt: "0.01"},
		{CoinFrom: "BTC", CoinTo: "XMR", AddrFrom: "b", Timestamp: now, TimeValid: 3600,
			AmountFromSt: "0.01", AmountToSt: "1.5"},
	}
	xmr := foldBook(offers, now)["xmr"]
	if got := len(xmr.pairs); got != 1 {
		t.Fatalf("pairs: want 1 market, got %d (%v)", got, xmr.pairs)
	}
	if got := len(xmr.makers); got != 2 {
		t.Fatalf("makers: want 2 distinct addresses, got %d", got)
	}
	if got := xmr.live; got != 2 {
		t.Fatalf("live offers: want 2, got %d", got)
	}
}

func TestExpiredOfferIsNotAMarket(t *testing.T) {
	now := int64(1_000_000)
	offers := []bsxOffer{
		{CoinFrom: "FIRO", CoinTo: "BTC", AddrFrom: "a", Timestamp: now - 7200, TimeValid: 3600,
			AmountFromSt: "10", AmountToSt: "0.01"},
	}
	firo := foldBook(offers, now)["firo"]
	if firo == nil {
		t.Fatal("firo is absent from the fold, so its gauge would keep its last value")
	}
	if len(firo.makers) != 0 || firo.live != 0 || firo.size != 0 {
		t.Fatalf("an expired offer must count for nothing, got makers=%d live=%d size=%v",
			len(firo.makers), firo.live, firo.size)
	}
}

// The one that was live in production: Firo held one maker for a full day
// with zero Firo offers in the feed, because a gauge that is never Set keeps
// its last value. foldBook has to return the coin so the caller publishes a
// zero over it.
func TestEveryCohortCoinIsReturnedEvenWithNoOffers(t *testing.T) {
	per := foldBook([]bsxOffer{
		{CoinFrom: "XMR", CoinTo: "BTC", AddrFrom: "a", Timestamp: 1_000_000, TimeValid: 3600,
			AmountFromSt: "1", AmountToSt: "0.01"},
	}, 1_000_000)

	for _, slug := range coinSlug {
		c, ok := per[slug]
		if !ok {
			t.Fatalf("%s is missing from the fold, so its gauge would keep its last value", slug)
		}
		if slug == "xmr" {
			continue
		}
		if len(c.makers) != 0 || c.live != 0 {
			t.Fatalf("%s has no offers and must fold to zero, got makers=%d live=%d",
				slug, len(c.makers), c.live)
		}
	}
}

func TestSizeComesFromTheSideTheCoinIsOn(t *testing.T) {
	now := int64(1_000_000)
	offers := []bsxOffer{
		{CoinFrom: "WOW", CoinTo: "BTC", AddrFrom: "a", Timestamp: now, TimeValid: 3600,
			AmountFromSt: "2285000", AmountToSt: "0.4"},
	}
	per := foldBook(offers, now)
	if got := per["wow"].size; got != 2285000 {
		t.Fatalf("WOW size: want the from-side amount 2285000, got %v", got)
	}
}
