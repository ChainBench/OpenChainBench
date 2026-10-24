package main

// The Mobula rail's sale direction: EVM in, Solana out.
//
// This is the row that could not be filled from chain reads alone, and the
// reason is specific to it. Of the six settlement routes, it is the only one
// where the RAIL and the APP are different parties:
//
//	pump-bridge    the rail IS the product, so nothing needs attributing
//	relay routes   the Relay feed is app-scoped and hands us the app
//	fomo-mobula    Mobula's rail serves many integrators, so the row has to
//	               PROVE the traffic is FOMO's
//
// On a buy that proof is the Solana gas sponsor, which is what mobulaFeed
// reads. On a sale the proof is gone: the Solana leg is fee-paid by the
// SOLVER, the EVM leg is sent from an infrastructure-minted vanity EOA with
// no code, and the bridge's contracts, events and fee wallet serve every
// integrator. Measured 2026-10-23, attribution by person (a sale delivering
// to someone we had seen buying) recovered 15%.
//
// THE ANSWER IS MOBULA'S OWN INTENTS API, and specifically one field of it.
// api.mobula.io/api/2/bridge/intents?intentId=<id> returns the intent with
// fees.integratorAddress, the wallet that collects the integrator's cut. On
// 24 of 24 sales read that address was
// R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX, which is the fee wallet this
// bench ALREADY declares for FOMO in config.go. So the attribution is checked
// against our own ground truth rather than against Mobula's label, and it is
// exact rather than 15%.
//
// Two earlier readings of mine were wrong in a way worth recording, because
// both were inferences from shape: 0x74647a56 "looked like" the deposit event
// and is mobulaFillTopic, and the 0x4337 senders "looked like" ERC-4337
// accounts and are codeless vanity EOAs. The integratorAddress claim is not
// of that kind: it was tested against an address list we wrote ourselves.
//
// WHAT THIS DELIBERATELY DOES NOT TAKE FROM THE API. The record also carries
// latencyMs and a timestamps block (depositDetected, fillSent, fillConfirmed).
// Publishing those would break the metric in two ways at once: they are
// Mobula's own instrumentation rather than block times, so they are not the
// quantity every other row in tfq_settle_ms reports, and they are
// self-reported by the party being measured. The API is used for the two
// things only it knows, the integrator and the two transaction hashes, and
// the times are read off the chains exactly as everywhere else.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	gMobulaSaleUp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "tfq_mobula_sale_feed_up",
		Help: "1 when the Mobula sale poller completed a pass. Separate from the deposit feed: the two read different accounts for opposite directions, so one being healthy says nothing about the other",
	})
	gMobulaSaleBehind = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "tfq_mobula_sale_feed_behind",
		Help: "1 when a pass filled its page while holding a cursor, meaning the solver produced deliveries faster than one pass read them and some were skipped. Every poller in this bench that lacked this gauge turned out to be losing data silently, so it ships with the feed rather than after someone notices",
	})
	cMobulaSaleSkipped = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "tfq_mobula_sale_skipped_total",
		Help: "Deliveries the sale poller may have walked past because a page filled with a cursor set. An upper bound, not a count of losses",
	})
	cMobulaSales = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_mobula_sales_total",
		Help: "Mobula sale deliveries seen, by the app that collects the integrator fee. app=undeclared means the integrator wallet is not one this bench declares for a route on the Mobula rail: counted rather than dropped, so another integrator's flow is visible instead of silently joining FOMO's row",
	}, []string{"app"})
	cMobulaSaleDrop = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_mobula_sale_dropped_total",
		Help: "Sale deliveries that produced no settlement, by reason. Kept apart because the reasons mean opposite things: no_record is the API not knowing an id, not_sale is a buy arriving on this path, unreadable_chain is an origin we have no endpoint for, and no_blocktime is a read that failed",
	}, []string{"reason"})
)

func init() {
	prometheus.MustRegister(gMobulaSaleUp, gMobulaSaleBehind, cMobulaSaleSkipped,
		cMobulaSales, cMobulaSaleDrop)
}

// mobulaSaleWallets maps an integrator fee wallet to the route it belongs to.
//
// Built from the terminals' DECLARED wallets, the same list the Solana rows
// use to find a terminal's fee, so a route is attributed here only if this
// bench already says that wallet is that app's. An integrator we do not
// declare does not match and is counted as undeclared, which is how a new
// rail user becomes visible rather than being absorbed into FOMO's row.
//
// Gated on settleRails exactly as mobulaApps is: a terminal with wallets but
// no declared Mobula route must not start publishing one.
func mobulaSaleWallets() map[string]string {
	declared := map[string]bool{}
	for _, p := range settleRails["mobula"] {
		declared[p] = true
	}
	out := map[string]string{}
	for _, t := range terminals {
		product := t.Slug + "-mobula"
		if !declared[product] {
			continue
		}
		for _, w := range t.Wallets {
			if w != "" {
				out[strings.ToLower(w)] = product
			}
		}
	}
	return out
}

// mobulaIntentRec is the part of an intent record this bench uses. The record
// carries a good deal more, including timings that are deliberately ignored;
// see the file comment.
type mobulaIntentRec struct {
	IntentID      string `json:"intentId"`
	Status        string `json:"status"`
	OriginChain   string `json:"originChainId"`      // "evm:56", "solana:solana"
	DestChain     string `json:"destinationChainId"` // "solana:solana" on a sale
	DepositTxHash string `json:"depositTxHash"`      // the origin leg
	FillTxHash    string `json:"fillTxHash"`         // the destination leg
	Fees          struct {
		IntegratorAddress string `json:"integratorAddress"`
	} `json:"fees"`
}

// isSale reports whether the record is an EVM to Solana leg.
//
// Read off destinationChainId, which the API states outright, rather than
// inferred from which hash looks like what. The origin must NOT be Solana
// too: a Solana to Solana record would otherwise pass and produce a
// settlement between two legs on one chain.
func (r mobulaIntentRec) isSale() bool {
	return strings.HasPrefix(r.DestChain, "solana") &&
		!strings.HasPrefix(r.OriginChain, "solana")
}

// originEvmChain resolves "evm:56" to a chain this bench can read.
func (r mobulaIntentRec) originEvmChain() (originChain, bool) {
	_, num, ok := strings.Cut(r.OriginChain, ":")
	if !ok {
		return originChain{}, false
	}
	id, err := strconv.ParseInt(num, 10, 64)
	if err != nil {
		return originChain{}, false
	}
	for i := range originChains {
		if originChains[i].id == id {
			return originChains[i], true
		}
	}
	return originChain{}, false
}

const mobulaIntentAPI = "https://api.mobula.io/api/2/bridge/intents"

// mobulaFetchIntent returns one intent record by id.
//
// The key is the one already passed to this container as MOBULA_API_KEY. The
// endpoint refuses an unauthenticated caller with 403 and a caller with no
// recognised filter with 400, so a nil return here means the id is unknown
// rather than that the call was malformed.
func mobulaFetchIntent(ctx context.Context, httpc *http.Client, id string) *mobulaIntentRec {
	key := os.Getenv("MOBULA_API_KEY")
	if key == "" || id == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		mobulaIntentAPI+"?intentId="+url.QueryEscape(id), nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", key)
	req.Header.Set("Accept", "application/json")
	resp, err := httpc.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var body struct {
		Data []mobulaIntentRec `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || len(body.Data) == 0 {
		return nil
	}
	return &body.Data[0]
}

// mobulaSaleFeed walks the solver's own signatures.
//
// The deposit feed reads the solver's USDC TOKEN ACCOUNT, because that is
// where a buy's deposit lands. A sale is the opposite leg and the solver
// signs and fee-pays it, so it is found on the solver address instead. The
// two feeds therefore read different accounts and neither subsumes the other.
type mobulaSaleFeed struct {
	cursor  string
	wallets map[string]string
	timed   map[string]bool
}

const (
	mobulaSalePageSize = 500
	mobulaSaleTimedMax = 20000
)

func newMobulaSaleFeed() *mobulaSaleFeed {
	return &mobulaSaleFeed{wallets: mobulaSaleWallets(), timed: map[string]bool{}}
}

func (f *mobulaSaleFeed) run(ctx context.Context, rpc *rpcClient, httpc *http.Client, every time.Duration) {
	if len(f.wallets) == 0 {
		log.Printf("[mobula-sale] no route declares a wallet on the Mobula rail; feed not started")
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		f.poll(ctx, rpc, httpc)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// poll reads one page of the solver's signatures and settles what it can.
func (f *mobulaSaleFeed) poll(ctx context.Context, rpc *rpcClient, httpc *http.Client) {
	sigs, err := rpc.signatures(ctx, mobulaSolver, mobulaSalePageSize, f.cursor)
	if err != nil {
		gMobulaSaleUp.Set(0)
		return
	}
	gMobulaSaleUp.Set(1)
	if len(sigs) == 0 {
		return
	}
	newest := sigs[0].Signature
	hadCursor := f.cursor != ""

	// A full page with a cursor set means the account produced faster than
	// one pass read it, and the cursor is about to jump past the gap. Two of
	// this bench's five pollers shipped without this check and both turned
	// out to be losing data, so it is here from the first version.
	if hadCursor && len(sigs) >= mobulaSalePageSize {
		gMobulaSaleBehind.Set(1)
		cMobulaSaleSkipped.Add(float64(len(sigs)))
		log.Printf("[mobula-sale] page full (%d) with a cursor set: the solver is delivering faster than one pass reads, deliveries were skipped", len(sigs))
	} else {
		gMobulaSaleBehind.Set(0)
	}

	txs := readParallel(ctx, sigs, sampleWorkers(), func(ctx context.Context, s sigInfo) *parsedTx {
		if s.failed() {
			return nil
		}
		tx, err := rpc.transaction(ctx, s.Signature)
		if err != nil || tx == nil || tx.BlockTime == nil {
			return nil
		}
		return tx
	})

	settled := 0
	for i := range sigs {
		tx := txs[i]
		if tx == nil {
			continue
		}
		id := mobulaSaleIntentOf(tx)
		if id == "" || f.timed[id] {
			continue
		}
		rec := mobulaFetchIntent(ctx, httpc, id)
		if rec == nil {
			cMobulaSaleDrop.WithLabelValues("no_record").Inc()
			continue
		}
		if !rec.isSale() {
			// A buy reached this path. The deposit feed owns that direction
			// and timing it here would publish it twice.
			cMobulaSaleDrop.WithLabelValues("not_sale").Inc()
			continue
		}
		product, known := f.wallets[strings.ToLower(rec.Fees.IntegratorAddress)]
		if !known {
			cMobulaSales.WithLabelValues("undeclared").Inc()
			continue
		}
		oc, ok := rec.originEvmChain()
		if !ok {
			cMobulaSaleDrop.WithLabelValues("unreadable_chain").Inc()
			continue
		}
		// Origin time from the chain, never from the record's own timings.
		var rc evmReceipt
		if err := evmCall(ctx, httpc, oc.logsRPC(), "eth_getTransactionReceipt",
			[]any{rec.DepositTxHash}, &rc); err != nil {
			cMobulaSaleDrop.WithLabelValues("no_blocktime").Inc()
			continue
		}
		bn := hexInt(rc.BlockNumber)
		if bn <= 0 {
			cMobulaSaleDrop.WithLabelValues("no_blocktime").Inc()
			continue
		}
		originAt := pumpBlockAt(ctx, httpc, oc, oc.slug, bn)
		if originAt <= 0 {
			cMobulaSaleDrop.WithLabelValues("no_blocktime").Inc()
			continue
		}
		// Destination time: this very transaction is the delivery.
		f.timed[id] = true
		cMobulaSales.WithLabelValues(product).Inc()
		noteSettle(product, settleTrade, "solana", float64(*tx.BlockTime-originAt))
		settled++
	}

	f.cursor = newest
	if len(f.timed) > mobulaSaleTimedMax {
		f.timed = map[string]bool{}
	}
	if settled > 0 {
		log.Printf("[mobula-sale] %d sale settlements on solana from %d signatures", settled, len(sigs))
	}
}

// mobulaSaleIntentOf reads the intent id off a delivery's memo.
//
// It exists because the two directions write the memo differently, which cost
// a deploy to find: mobulaIntentOf requires {"intentId":"..."} and returns
// empty on anything else, so the sale feed ran, reported itself healthy and
// incremented not one counter. On a sale the memo is the BARE id.
//
//	buy   {"intentId":"5976756-d392c16-095"}
//	sale  5194d07-33b0871-3b8
//
// The JSON form is tried first and delegated, so the two readers cannot drift.
// The bare form is accepted only on an exact shape, three dash-separated
// lowercase hex groups of 7, 7 and 3, which is what every id observed looks
// like. That strictness is the point: this memo program is public and carries
// whatever any integrator writes, so an accepting reader would turn a stray
// note into an intent id and then into a settlement against an unrelated
// transaction.
func mobulaSaleIntentOf(tx *parsedTx) string {
	if id := mobulaIntentOf(tx); id != "" {
		return id
	}
	for _, ix := range tx.Transaction.Message.Instructions {
		if ix.ProgramID != mobulaMemoProgram || len(ix.Parsed) == 0 {
			continue
		}
		var text string
		if err := json.Unmarshal(ix.Parsed, &text); err != nil {
			continue
		}
		if id := strings.TrimSpace(text); mobulaBareIntentID(id) {
			return id
		}
	}
	return ""
}

// mobulaBareIntentID reports whether a memo is an intent id and nothing else.
func mobulaBareIntentID(s string) bool {
	parts := strings.Split(s, "-")
	if len(parts) != 3 || len(parts[0]) != 7 || len(parts[1]) != 7 || len(parts[2]) != 3 {
		return false
	}
	for _, p := range parts {
		for _, c := range p {
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				return false
			}
		}
	}
	return true
}
