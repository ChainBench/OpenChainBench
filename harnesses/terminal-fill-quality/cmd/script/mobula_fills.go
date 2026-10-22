package main

// The EVM half of the Mobula route: the fills, and the join.
//
// One eth_getLogs per chain per pass, filtered on the bridge contract and the
// fill event, then the intent id is read straight out of word 0 of the log's
// data as right-padded ascii. That is the whole decode: the event carries the
// id and nothing else, no recipient and no token, which is why pricing a fill
// needs the receipt and the sink rule (see xchain.go) while TIMING one needs
// only this.
//
// Settlement is published here and pricing is not, on purpose. The timing is
// exact as soon as the two legs are joined, and the join is exact. Pricing
// goes through the audited evmRow path and the row it produces is a separate
// change; shipping the timing first means the route appears with a figure that
// cannot be wrong rather than waiting on one that can.

import (
	"context"
	"encoding/hex"
	"log"
	"math/big"
	"strings"
	"time"

	"net/http"
)

// mobulaFillWatcher walks each chain's bridge contract forward.
type mobulaFillWatcher struct {
	cursor map[string]int64
}

func newMobulaFillWatcher() *mobulaFillWatcher {
	return &mobulaFillWatcher{cursor: map[string]int64{}}
}

func (w *mobulaFillWatcher) run(ctx context.Context, httpc *http.Client, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	w.poll(ctx, httpc)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.poll(ctx, httpc)
		}
	}
}

func (w *mobulaFillWatcher) poll(ctx context.Context, httpc *http.Client) {
	for chain, bridge := range mobulaBridge {
		if ctx.Err() != nil {
			return
		}
		var c originChain
		found := false
		for _, oc := range originChains {
			if oc.slug == chain {
				c, found = oc, true
				break
			}
		}
		if !found {
			// A chain Mobula settles on that this bench has no endpoint
			// for. Logged once a pass rather than skipped silently: an
			// absent chain is 79% of this route if it is Robinhood.
			log.Printf("[mobula-fill] %s: no originChain declared, fills on it are not read", chain)
			continue
		}
		w.pollChain(ctx, httpc, c, chain, bridge)
	}
}

// mobulaFillReach: how far back the fill watcher reads, in SECONDS of chain.
//
// It was a flat 600 blocks, and that lost most of Robinhood. The cold-start
// clause discards the cursor whenever a chain advances more than the span
// between two passes, so with a two-minute tick:
//
//	robinhood  0.10 s a block  ->  600 blocks = 60 s, chain moves ~1,200,
//	                                cursor thrown away every pass, about
//	                                half of every interval never read
//	bnb        0.75 s          ->  7.5 min, cursor survives
//	base       2.00 s          ->  20 min, survives
//	ethereum  12.00 s          ->  2 h, survives
//
// The symptom was 12 pairs with bnb 9, ethereum 2, base 1 and NONE on
// Robinhood, which is 57% of this route. A flat block count means a different
// thing on every chain, which is the same error as comparing settlement
// milliseconds across chains with different block times.
//
// 15 minutes: comfortably over the two-minute tick even after a slow pass or
// a restart, and under the deposit window's 30-minute reach, so it never
// reads fills whose intent could not still be held.
const mobulaFillReach = 15 * 60

// mobulaBlockSeconds: measured block times, used only to turn mobulaFillReach
// into a block count. A chain absent here gets the slowest assumption, which
// reads MORE chain rather than less: over-reading costs an unknown_intent
// count, under-reading loses fills silently.
var mobulaBlockSeconds = map[string]float64{
	"robinhood": 0.10,
	"bnb":       0.75,
	"base":      2.00,
	"ethereum":  12.00,
	"arc":       1.00,
}

func mobulaSpanOf(chain string) int64 {
	sec, ok := mobulaBlockSeconds[chain]
	if !ok || sec <= 0 {
		sec = 12
	}
	n := int64(float64(mobulaFillReach) / sec)
	if n < 100 {
		n = 100
	}
	// A cap, because a chain whose block time we have wrong must not ask an
	// endpoint for a range it will refuse: a rejected getLogs reads as a
	// quiet bridge.
	if n > 20000 {
		n = 20000
	}
	return n
}

func (w *mobulaFillWatcher) pollChain(ctx context.Context, httpc *http.Client, c originChain, chain, bridge string) {
	var headHex string
	if err := evmCall(ctx, httpc, c.logsRPC(), "eth_blockNumber", []any{}, &headHex); err != nil {
		log.Printf("[mobula-fill] %s: head: %v", chain, err)
		return
	}
	head := hexInt(headHex)
	if head <= 0 {
		return
	}
	span := mobulaSpanOf(chain)
	from := w.cursor[chain]
	if from <= 0 || head-from > span {
		// Losing ground: either a cold start or a pass that fell behind the
		// chain. Logged when it is the second case, because that is the
		// state in which fills are being skipped and nothing else says so.
		if from > 0 {
			log.Printf("[mobula-fill] %s: %d blocks behind, past the %d-block reach: fills in between are not read",
				chain, head-from, span)
		}
		from = head - span
	}
	if from < 0 {
		from = 0
	}
	if from > head {
		return
	}

	var logs []evmLog
	err := evmCall(ctx, httpc, c.logsRPC(), "eth_getLogs", []any{map[string]any{
		"fromBlock": "0x" + big.NewInt(from).Text(16),
		"toBlock":   "0x" + big.NewInt(head).Text(16),
		"address":   bridge,
		"topics":    []any{mobulaFillTopic},
	}}, &logs)
	if err != nil {
		log.Printf("[mobula-fill] %s: getLogs %d-%d: %v", chain, from, head, err)
		return
	}
	// to+1: eth_getLogs includes both bounds, so leaving the cursor at head
	// re-reads head's logs on the next pass and double-counts its fills.
	w.cursor[chain] = head + 1

	paired := 0
	for _, l := range logs {
		id := mobulaIDFromData(l.Data)
		if id == "" {
			continue
		}
		in, ok := mobulaTakeIntent(id)
		if !ok {
			cMobulaFills.WithLabelValues(chain, "unknown_intent").Inc()
			continue
		}
		cMobulaFills.WithLabelValues(chain, "paired").Inc()
		paired++
		bn := hexInt(l.BlockNumber)
		if bn <= 0 {
			continue
		}
		at := pumpBlockAt(ctx, httpc, c, chain, bn)
		if at <= 0 || in.At <= 0 {
			continue
		}
		// Same definition as every other settlement on this bench:
		// destination block time minus origin block time. noteSettle drops
		// anything over 60 s and under 0, so a clock skew between two
		// chains cannot publish a negative figure.
		noteSettle(in.App, settleTrade, chain, float64(at-in.At))
	}
	if len(logs) > 0 {
		log.Printf("[mobula-fill] %s: %d fills in blocks %d-%d, %d paired",
			chain, len(logs), from, head, paired)
	}
}

// mobulaIDFromData reads the intent id out of word 0 of the event's data.
//
// The id is a 19-character ascii string right-padded with zero bytes inside a
// 32-byte word, e.g.
//
//	0x323637373935382d303937376331322d35376400...  "2677958-0977c12-57d"
//
// Returns "" on anything that does not decode to printable ascii, so a
// changed event layout stops the join instead of pairing on rubbish. That is
// the same choice as logWordUSD refusing short data on the pump dust gate: a
// decoder that guesses is worse than one that stops.
func mobulaIDFromData(data string) string {
	s := strings.TrimPrefix(data, "0x")
	if len(s) < 64 {
		return ""
	}
	raw, err := hex.DecodeString(s[:64])
	if err != nil {
		return ""
	}
	id := strings.TrimRight(string(raw), "\x00")
	if len(id) < 8 {
		return ""
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x20 || id[i] > 0x7e {
			return ""
		}
	}
	return id
}
