package main

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

// Where the Relay sale path gives up, by reason.
//
// Added after the first deploy of this file published nothing on four routes
// while the Mobula rail published 594 samples, and I had no way to tell
// whether the sample held no sale legs at all or every read was failing. The
// Mobula feed shipped with exactly this counter and told me what it was doing
// within one pass; this one did not and cost a deploy. The reasons are kept
// apart because they mean opposite things: no_candidates is the feed handing
// us nothing to time, while a read failure is our side not managing it.
var cXchainSaleDrop = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "tfq_xchain_sale_dropped_total",
	Help: "Relay sale legs that produced no Solana settlement, by reason. no_candidates means the drained sample held no EVM-origin leg at all, which is a feed question and not a read failure",
}, []string{"reason"})

func init() { prometheus.MustRegister(cXchainSaleDrop) }

// The sale direction: EVM in, Solana out.
//
// Settlement is destination block time minus origin block time, and the chain
// label on a sample is the DESTINATION. Every path that existed before this
// file measured a Solana-origin trade, so every sample landed on an EVM chain
// and the metric carried no chain="solana" series at all. The Solana tab of
// the settlement panel was therefore empty, not because a route was broken
// but because the question had no data behind it.
//
// That gap is not small. Read against the Relay feed on 2026-10-23, 19 of 39
// bridged legs were EVM to Solana: the direction nobody timed is roughly half
// the flow.
//
// It was skipped on purpose rather than by accident. settleXchainTodo keeps
// Solana-origin requests only, because timing a sale with the buy direction's
// reads would resolve both ends on the destination EVM chain and publish a
// difference between two EVM blocks, which is not a settlement.
// TestOnlySolanaOriginRequestsAreTimed states exactly that, and it stays
// true: this file does not loosen that filter, it adds the other pair of
// reads beside it.
//
//	buy   origin = Solana tx blockTime      destination = EVM block timestamp
//	sale  origin = EVM block timestamp      destination = Solana tx blockTime
//
// Both halves already existed and neither is new work: noteSettleTx resolves
// an EVM hash to its block timestamp, and rpcClient.transaction resolves a
// Solana signature to its blockTime.

// saleLeg reports whether a request is an EVM to Solana leg this bench can
// time, and names the origin chain.
//
// The direction is read off the SHAPE of the two hashes rather than off a
// field, because the feed has no field that says "sale": DestChain is simply
// empty when the destination is Solana. An EVM hash is 0x-prefixed hex and a
// Solana signature is base58, so a leg whose input is 0x and whose output is
// not is unambiguous. Testing the value this way rather than trusting a label
// is what the buy path does too.
//
// Requiring the origin chain to be one we already read matters: a leg from a
// chain with no endpoint configured would cost a failed read per tick and
// teach nothing, which is why the buy path refuses unreadable destinations.
func saleLeg(x relayRequest) (originChain, bool) {
	if x.DestChain != "" || x.InTx == "" || x.OutTx == "" {
		return originChain{}, false
	}
	if x.Chain == "" || x.Chain == "solana" {
		return originChain{}, false
	}
	// An EVM transaction hash in, a Solana signature out. Both checks are
	// needed: a 0x output would mean the destination is an EVM chain and the
	// leg is not ours to time here.
	if !strings.HasPrefix(x.InTx, "0x") || strings.HasPrefix(x.OutTx, "0x") {
		return originChain{}, false
	}
	for i := range originChains {
		if originChains[i].slug == x.Chain {
			return originChains[i], true
		}
	}
	return originChain{}, false
}

// settleXchainSaleTodo picks the sale legs worth timing: EVM-origin on a
// chain we read, both hashes present and of the right shape, not already
// timed.
//
// It shares the caller's done map with the buy path on purpose. Request ids
// are unique across directions, so one map cannot confuse the two, and the
// Relay feed re-walks requests after a restart: a leg timed twice would
// inflate the sample behind a published mean while looking like more data.
func settleXchainSaleTodo(sample []relayRequest, done map[string]bool, limit int) []relayRequest {
	var todo []relayRequest
	for _, x := range sample {
		if limit > 0 && len(todo) >= limit {
			break
		}
		if done[x.ID] {
			continue
		}
		if _, ok := saleLeg(x); !ok {
			continue
		}
		todo = append(todo, x)
	}
	return todo
}

// settleXchainSale times every EVM to Solana leg in the sample and returns
// how many it recorded.
//
// Every sample it publishes carries chain="solana", because that is where the
// trade landed. This is the only path in the bench that produces that label.
//
// One consequence worth stating rather than discovering: noteSettle pools a
// route's chains into its chain="all" series, so a route that gains the sale
// direction will see its all-chains figure move. That is correct, the
// population genuinely grew, but it means the headline numbers change on the
// deploy that ships this.
func settleXchainSale(ctx context.Context, rpc *rpcClient, httpc *http.Client, slug string, sample []relayRequest, done map[string]bool) int {
	product, _ := settleRoute(slug)
	if product == "" {
		return 0
	}
	todo := settleXchainSaleTodo(sample, done, settleXchainPerTick)
	if len(todo) == 0 {
		if len(sample) > 0 {
			cXchainSaleDrop.WithLabelValues("no_candidates").Inc()
		}
		return 0
	}
	type timed struct {
		id   string
		took float64
		ok   bool
	}
	out := readParallel(ctx, todo, sampleWorkers(), func(ctx context.Context, x relayRequest) timed {
		oc, ok := saleLeg(x)
		if !ok {
			return timed{}
		}
		// Origin: the EVM transaction the user signed, resolved to its
		// block's timestamp. Two reads, the second usually served from
		// pumpBlockAt's per-chain cache.
		var rc evmReceipt
		if err := evmCall(ctx, httpc, oc.logsRPC(), "eth_getTransactionReceipt", []any{x.InTx}, &rc); err != nil {
			cXchainSaleDrop.WithLabelValues("receipt").Inc()
			return timed{}
		}
		bn := hexInt(rc.BlockNumber)
		if bn <= 0 {
			cXchainSaleDrop.WithLabelValues("no_blocknumber").Inc()
			return timed{}
		}
		originAt := pumpBlockAt(ctx, httpc, oc, x.Chain, bn)
		if originAt <= 0 {
			cXchainSaleDrop.WithLabelValues("no_origin_time").Inc()
			return timed{}
		}
		// Destination: the Solana transaction that delivered the token.
		outTx, err := rpc.transaction(ctx, x.OutTx)
		if err != nil || outTx == nil || outTx.BlockTime == nil {
			cXchainSaleDrop.WithLabelValues("no_solana_time").Inc()
			return timed{}
		}
		return timed{id: x.ID, took: float64(*outTx.BlockTime - originAt), ok: true}
	})
	n := 0
	for _, r := range out {
		if !r.ok {
			continue
		}
		// Marked done even when noteSettle refuses the value below: a leg
		// whose two ends disagree is not going to agree on the next tick, and
		// retrying it forever would spend the budget on the same failure.
		done[r.id] = true
		noteSettle(product, settleTrade, "solana", r.took)
		cXchainTimed.WithLabelValues(slug).Inc()
		n++
	}
	return n
}

// pumpSaleTimed: order ids whose sale settlement has been recorded.
//
// The pump sale join is exact and already exists: the EVM leg carries an
// order id and pumpFindPayout returns the Solana delivery filed under it. So
// this direction costs no new read at all, only the origin block's timestamp,
// which pumpBlockAt serves from its per-chain cache.
//
// The dedupe is still needed. A sale that arrives before its delivery is held
// in pumpPendingSales and re-read on a later tick, so the same order can pass
// through the pricing path more than once in a process's life. Counting it
// twice would inflate the sample behind a published mean while looking like
// more data, which is the same failure the buy path's done map exists to
// prevent.
var pumpSaleTimed struct {
	sync.Mutex
	by map[string]int64
}

const (
	pumpSaleTimedMax = 20000
	pumpSaleTimedAge = 2 * 60 * 60 // seconds
)

// noteSettlePumpSale records one Pump Bridge sale's settlement, once.
//
// originAt is the EVM block the user's sale landed in; destAt is the Solana
// block of the delivery pump made afterwards. The order is always EVM first
// and Solana second, which is why pumpPendingSales exists, so a negative
// difference means the two ends were misread rather than that the bridge went
// backwards. noteSettle refuses those, and this returns early on the obvious
// ones so a misread never reaches the window at all.
func noteSettlePumpSale(order string, originAt, destAt int64) {
	if order == "" || originAt <= 0 || destAt <= 0 || destAt < originAt {
		return
	}
	pumpSaleTimed.Lock()
	if pumpSaleTimed.by == nil {
		pumpSaleTimed.by = map[string]int64{}
	}
	if _, dup := pumpSaleTimed.by[order]; dup {
		pumpSaleTimed.Unlock()
		return
	}
	pumpSaleTimed.by[order] = destAt
	if len(pumpSaleTimed.by) > pumpSaleTimedMax {
		cut := destAt - pumpSaleTimedAge
		for k, v := range pumpSaleTimed.by {
			if v < cut {
				delete(pumpSaleTimed.by, k)
			}
		}
	}
	pumpSaleTimed.Unlock()

	// chain="solana": the delivery landed there, and the chain label on a
	// settlement is always the destination.
	noteSettle("pump-bridge", settleTrade, "solana", float64(destAt-originAt))
}
