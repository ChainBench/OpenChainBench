package main

// WalkOrderbook walks a sorted side of an orderbook (asks ascending for a
// buy, bids descending for a sell) until either targetUSD of notional has
// been consumed or the levels are exhausted.
//
// Returns:
//   slippageBps: signed effective execution price vs mid, in basis points.
//                Positive means the trader paid worse than mid (buy side)
//                or received worse than mid (sell side). Callers pass the
//                mid used to compute the reference, and normalize sign at
//                the record site so the metric is always "cost to trader"
//                >= 0 in the happy path.
//   filledUSD:   how much notional the walk was actually able to consume.
//                Always <= targetUSD.
//   ok:          true when filled >= 99% of targetUSD, i.e. the venue has
//                enough depth to fill the size. When false, filledUSD is
//                the max_fillable_usd and slippage bps should be ignored.
func WalkOrderbook(orders []Level, targetUSD float64, mid float64) (slippageBps float64, filledUSD float64, ok bool) {
	if mid <= 0 || targetUSD <= 0 {
		return 0, 0, false
	}
	var filled, base float64
	for _, o := range orders {
		if o.Price <= 0 || o.Size <= 0 {
			continue
		}
		avail := o.Size * o.Price
		remaining := targetUSD - filled
		take := avail
		if take > remaining {
			take = remaining
		}
		filled += take
		base += take / o.Price
		if filled >= targetUSD {
			break
		}
	}
	if base == 0 {
		return 0, 0, false
	}
	avg := filled / base
	slippageBps = (avg - mid) / mid * 10000
	return slippageBps, filled, filled >= targetUSD*0.99
}

// Mid computes the mid price from the top of book. Returns 0 when either
// side is empty; callers treat that as an unhealthy tick.
func Mid(book *OrderBook) float64 {
	if len(book.Bids) == 0 || len(book.Asks) == 0 {
		return 0
	}
	bb := book.Bids[0].Price
	ba := book.Asks[0].Price
	if bb <= 0 || ba <= 0 {
		return 0
	}
	return (bb + ba) / 2
}

// SpreadBps is (best_ask - best_bid) / mid, in basis points. Returns 0
// when the book is one-sided; callers check book health separately.
func SpreadBps(book *OrderBook) float64 {
	mid := Mid(book)
	if mid == 0 {
		return 0
	}
	bb := book.Bids[0].Price
	ba := book.Asks[0].Price
	return (ba - bb) / mid * 10000
}
