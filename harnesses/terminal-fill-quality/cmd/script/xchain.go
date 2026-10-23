package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/prometheus/client_golang/prometheus"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cross-chain trades through Relay.
//
// FOMO (and BasedBot) let a user pay on BNB, Robinhood Chain, Base,
// Ethereum or Arc and receive a Solana token: the app quotes a Relay
// request with its fee attached (appFees to its own address), the user
// deposits on the origin chain, a Relay solver settles on Solana by
// buying the token and sending it to the user's wallet. Nothing on
// Solana pays the app's fee wallet, so the fee-wallet feed never sees
// these swaps; Relay's public requests API does, with what the user paid
// in USD, every fee (app, Relay, execution, and which of them the user
// actually paid after sponsorship), both transaction hashes and the
// status (success, refund, failure).
//
// Measurement: value given = the origin deposit in USD (Relay's figure,
// the amount the user sent) + the origin gas (receipt on the origin
// chain's public RPC); value received = the tokens delivered on Solana
// valued at the pool's state before the settlement swap, read from the
// Solana transaction exactly like a native swap (the recipient is the
// user, the solver is the payer). Components: terminal = app fee the
// user paid, relay = Relay's own fees the user paid, network = origin
// gas, pool = the rest (settlement impact and LP fee, Relay's spread).
//
// Requests whose Solana side delivers SOL or a stable (a sell from the
// origin chain) have no token leg on Solana and are not priced here.

type xchainApp struct {
	Slug          string
	Name          string
	FeeRecipients []string // app-fee recipients (EVM addresses, lower-case) that identify the app
	Referrer      string   // Relay referrer, when the app's requests are public under it
	FundingOnly   bool     // its Relay requests are wallet funding, never a trade: no per-chain trading rows from the feed
}

var xchainApps = []xchainApp{
	// FOMO's cross-chain fee address: the recipient of the 45 to 55 bps app
	// fee on the Relay requests settling to wallets that also trade FOMO
	// natively on Solana (join on Mobula's FOMO-attributed trades, 133 of
	// 2,000 settlements on 2026-09-18); FOMO's referrer is private (403).
	{Slug: "fomo", Name: "FOMO", FeeRecipients: []string{"0x9fc4e320a181e88644a302d11f1f158ef0699e37"}},
	// pump.fun app's multichain trading (since 2026-05-26: pay in SOL, gas
	// sponsored): its Relay app fee, 15 bps, to one recipient, every request
	// subsidized; the Solana users behind it trade through the app's
	// program 6Vo3245e… (29 of 96 recent transactions of 12 users, none of
	// the users behind the other recipients do). 313 of 6,000 Solana-origin
	// requests to EVM tokens on 2026-09-21: Robinhood Chain 225, BNB 52,
	// HyperEVM 10, Arc 10.
	{Slug: "pump-fun", Name: "pump.fun app", FeeRecipients: []string{"0xdab3f5fcd43211345f1789bf734b5fc5aef1adf7"}},
	// Phantom's cross-chain swap: an app fee at 85 bps (its 0.85 % swap
	// fee), paid from Solana in CASH (Phantom's dollar token: 40 of 57
	// requests on 2026-09-21), SOL or USDC, gas not sponsored; the Solana
	// users behind it touch Phantom's fee account and no other terminal's.
	//
	// TWO recipients, because it changed and the rows went silent. On 100
	// requests under the phantom referrer, read 2026-10-23, 0x74f9cb25…
	// appears 0 times and 0x037da4f7… appears 83. So every phantom-<chain>
	// row had been ABSENT rather than thin: not one request could be
	// recognised as Phantom's.
	//
	// The old address stays. It costs one comparison per request, and it
	// means a rollback on Phantom's side does not blind the rows a second
	// time: the same reasoning as never deleting a row whose slug moved.
	//
	// This is the failure mode with no symptom. A fee wallet that falls out
	// of use does not error, does not log, and does not make a published
	// figure look wrong; the rows simply never appear, and an absent row
	// reads as "the app does not do this" rather than "we stopped being
	// able to see it". Its routes, same sample: Solana to Ethereum 17,
	// Solana to Hyperliquid 15, Solana to Robinhood 13, Robinhood to Solana
	// 12, Ethereum to Solana 11, Base and BNB both ways 15.
	{Slug: "phantom", Name: "Phantom", FeeRecipients: []string{
		"0x037da4f70ea2e62c3c7a962a3bce5fcc41509a02",
		"0x74f9cb25fd81db31b4daf97ec121c01873581a57",
	}},
	// BasedBot's requests fund its users' wallets on Robinhood Chain, BNB, Base
	// and Ethereum (SOL in, the gas coin out, no app fee); its trades are the
	// funded wallets' swaps on Robinhood Chain's router (native.go).
	{Slug: "basedbot", Name: "BasedBot", Referrer: "BasedBot", FundingOnly: true},
}

// Origin chains Relay users pay from, with a public RPC for the gas
// receipt and the gas token's Coinbase pair ("" = a $1 stable).
type originChain struct {
	id   int64
	slug string
	rpc  []string // public endpoints, tried in order (a receipt is one call)
	gas  string
}

var originChains = []originChain{
	{56, "bnb", []string{"https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org", "https://1rpc.io/bnb", "https://bsc.drpc.org"}, "BNB-USD"}, // drpc last: the one public BSC node serving debug_traceTransaction
	{4663, "robinhood", []string{"https://rpc.mainnet.chain.robinhood.com"}, "ETH-USD"},
	{8453, "base", []string{"https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"}, "ETH-USD"},
	{1, "ethereum", []string{"https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"}, "ETH-USD"},
	{5042, "arc", []string{"https://rpc.mainnet.arc.io"}, ""},
	// HyperEVM needs EVM_RPC_HYPEREVM: the public node answers two address-filtered eth_getLogs
	// and then rate-limits (measured 2026-09-22: 10 failures in 12 calls), which is what left its
	// swaps unpriced. drpc is gone from the fallback, it now 403s every request. Measured
	// address-filtered getLogs spans: Alchemy 100,000 blocks, Chainstack 5,000, QuickNode and the
	// public node 1,000. Priced from Hyperliquid's mids (Coinbase does not list HYPE).
	{999, "hyperevm", []string{"https://rpc.hyperliquid.xyz/evm"}, "HYPE-USD"},
	// The two chains Relay does not serve, so Pump Bridge is the only route
	// on them and no bridge aggregator's feed can see them. Both carry the
	// same 21,998-byte Pump Bridge router as every other chain; the relayer's
	// nonce says what that is worth today, 28 on X Layer and 0 on MegaETH.
	// MegaETH is declared while dormant on purpose: that is what catches its
	// first trade rather than noticing months later.
	//
	// Measured address-filtered getLogs spans: MegaETH 5,000 blocks,
	// X Layer 50 on both its public endpoint and thirdweb's. The 50 is left
	// to the feed's own adaptive span rather than hardcoded, so it recovers
	// if the endpoint ever serves more.
	// MegaETH: the public node serves 5,000 block spans and the QuickNode
	// one in EVM_RPC_MEGAETH serves 10,000 (413 above that).
	{4326, "megaeth", []string{"https://mainnet.megaeth.com/rpc"}, "ETH-USD"},
	// X Layer NEEDS EVM_RPC_XLAYER. Every public endpoint caps eth_getLogs
	// at 100 blocks or less (rpc.xlayer.tech says "block range greater
	// than 100 max"; thirdweb and OKX cap near 50) and the chain produces
	// blocks far faster, so on the public list alone the cursor never
	// leaves block 0 and the gauge reads down forever. That is not
	// theoretical: it was declared, deployed and removed again within the
	// hour on 2026-10-21. The Chainstack node serves 10,000 blocks, which
	// keeps up. The public ones stay as fallback for the lighter calls.
	{196, "xlayer", []string{"https://rpc.xlayer.tech", "https://196.rpc.thirdweb.com"}, ""},
}

// relaySkips: origin chains Relay does not serve.
//
// They sit in originChains because Pump Bridge's routers are deployed there and
// the feed needs an endpoint, not because a Relay request can settle on them.
// The row builders read originChains as the destinations a Relay user can reach,
// so without this each app gets a row on each of them that can never fill: it
// publishes as unresponsive and reads as a broken route rather than an absent
// one. Pump Bridge is the only way onto these two chains, and its rows come
// from evmTerminals.
var relaySkips = map[string]bool{"megaeth": true, "xlayer": true}

// The cross-chain rails an app's Solana users can leave through, and how each
// is recognised. Declared here rather than left in a scratchpad because the
// addresses cost more to find than anything else in this file.
//
// HOW RELAY ATTRIBUTES, verified on chain 2026-10-22 and the basis for all of
// it: the APP is the Solana transaction's FEE PAYER, its gas sponsor, and the
// RAIL is the account the deposit credits. The app is never identified on the
// destination chain, which is why every EVM-side marker tried on Mobula's
// bridge failed: its fee wallet, its router address and its own events all
// serve whoever integrates it.
//
//	relayDepository  Relay's Solana depository. 231 hits in 9,000 of FOMO's
//	                 sponsor transactions (2.57%), 290 in an earlier 6,000.
//	mobulaSolver     Mobula's solver EOA, from bridge.mobula.io's own bundle
//	                 and then verified on chain: a system-owned wallet that
//	                 signs and fee-pays its own transactions.
//	mobulaSolverUSDC Its USDC token account, which is where deposits actually
//	                 land.
//
// THE TRAP, and the reason 15,000 transactions were scanned for nothing: a
// deposit credits a TOKEN ACCOUNT OWNED BY the solver, not the solver address.
// A token account's address has no relationship to its owner's, so matching
// account keys against the solver can never hit. Match the OWNER, or, since
// every Solana-origin deposit measured was USDC, match the fixed ATA below and
// pay no owner lookups at all.
//
// Measured split of FOMO's bridging over 398 sponsor transactions: Relay 17,
// Mobula 6, so Mobula carries roughly a quarter of it.
//
// Where that quarter goes, over 29 fills read 2026-10-23: Robinhood Chain 23,
// Base 3, BNB 2, Ethereum 1. Robinhood is about 79% of it, so a watcher that
// covers only the chains with the most total flow would miss most of this
// route. Direction split over 400 intents: 60% leaving Solana, 40% selling
// back to it, and the join works both ways, so neither direction can be
// skipped as an edge case.
const (
	relayDepository  = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2"
	mobulaSolver     = "oMcssxWxgooErb8bsRA4QN34VHhvfeEbdDjrwF6WH45"
	mobulaSolverUSDC = "BWocXaSJ46XRSnTUA92ffLzLriM7V8tHVLoUnS9HoWQz"
)

// THE JOIN, measured 2026-10-23 and the reason this route does not need the
// pairing Pump Bridge needs.
//
// Every Mobula deposit carries a plaintext memo from mobulaMemoProgram:
//
//	{"intentId":"5976756-d392c16-095"}
//
// and the SAME id appears in the fill on the destination chain, in the data of
// the mobulaFillTopic event emitted by the bridge contract, as right-padded
// ascii in word 0. So the two legs join on an exact key read from chain at
// both ends: no amount tolerance, no lag window, no ambiguous case, none of
// what the pump pairing has to live with.
//
// Verified 29 of 29 Solana->EVM fills and 14 of 14 the other way, matching
// ONLY the full dashed id (38 hex characters). That floor matters: a first
// pass that also accepted the id's 3-character tail reported 10 of 10 where
// the strict matcher found 4, because a short hex string appears in a 20-log
// receipt by accident. A match criterion needs a specificity floor, not just
// a hit.
//
// ATTRIBUTION IS STILL THE FEE PAYER. The memo proves a deposit belongs to a
// fill; it says nothing about which app sent it, because any Mobula
// integrator writes the same memo. The app test on the Solana leg stays "the
// fee payer is the app's sponsor", exactly as for Relay.
const (
	mobulaMemoProgram = "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH"
	// Fill(bytes32 indexed, string intentId, ...): topic0 of the event whose
	// data word 0 holds the intent id. One eth_getLogs per chain on
	// mobulaBridge filtered by this topic finds every fill.
	mobulaFillTopic = "0x74647a56026fd5e5a5fdb01d686969d17f40667aeedffef44cdeb894156e35a4"
)

// mobulaBridge: Mobula's EVM settlement contract per chain. SHARED
// infrastructure, serving whoever integrates its API, so a fill here says
// nothing about which app it belongs to: attribution has to come from the
// Solana origin above. Ethereum uses a different address from the rest.
//
// Its fills are a trade, not a transfer: the destination token was a memecoin
// on 239 of 239 Solana-origin intents measured, which is why this route
// belongs on this bench at all.
//
// NOT ALL FILLS CONTAIN A SWAP, but far fewer than first thought. Over 70
// fills read on chain, 66 carry a swap event and 4 (6%) come out of the
// contract's own inventory; an earlier count of 4 in 12 was small-sample. All
// four no-swap fills are on Robinhood and three deliver the same token, so it
// looks like inventory in one or two particular tokens rather than a general
// behaviour. They still need the pool's state at that block, since 6%
// dropping out by TRANSACTION SHAPE is still a selection, but it is not the
// third of the row we were braced for. On such a fill the user's shortfall is
// Mobula's quote spread rather than price impact, so it belongs in the
// bridge's own cost and not in `pool`.
//
// EVERY fill delivers a token: 0 of 70 delivered a dollar stable. So this
// route is a fill and not a transfer, which is what puts it under the trade
// kind rather than the funding kind.
//
// MULTI-VENUE IS NOT THE RISK IT LOOKED LIKE. Venue counts over 66 fills are
// v4 37, v2 22, v3 21, pancake-v3 19, summing past the fill count, and I read
// that as parallel legs the single-pool pricer could not handle. Replaying
// priceEvmSettlement on 60 real fills says otherwise: pools per fill are 1
// pool 48, 2 pools 3, 3 pools 4, 4 pools 1, and the extra venues are
// SEQUENTIAL HOPS (a stable to WETH on v3, then WETH to the token on v4),
// which the pricer already handles. Implausible splits are 2 of 60, 3%,
// against 1 to 3 of 57 on pump. So a venue count above the fill count does
// not mean parallel legs, and this route is priceable as it stands.
var mobulaBridge = map[string]string{
	"base":      "0xa834e70303322d86e5dae95ee47e9c6a073d9812",
	"bnb":       "0xa834e70303322d86e5dae95ee47e9c6a073d9812",
	"robinhood": "0xa834e70303322d86e5dae95ee47e9c6a073d9812",
	"ethereum":  "0xab830fcccb4f20bad23b7669d58cb35a96d57d5a",
}

// HOW THE USER AND THE TOKEN ARE FOUND IN A FILL, and how the rule was
// checked, since the fill event carries only the intent id.
//
// THE SINK RULE: the user is the address that RECEIVES a token in the fill
// and SENDS none. Pools, routers, executors and the bridge all appear on both
// sides of some transfer because value passes through them; a user is a dead
// end. The token is whatever that address received, SUMMED over every
// transfer of it.
//
// Checked against the explorer's own recipient, token and amountOut, which is
// an independent answer rather than a restatement of my reading: the rule
// finds the explorer's recipient as a dead end in 48 of 50 fills, and the
// summed amount matches amountOut exactly in 50 of 50.
//
// IT FAILED ITS FIRST VERSION, in two ways worth keeping:
//   - taking the LARGEST transfer to the user instead of the sum, which is
//     wrong whenever the fill is multi-venue, and multi-venue is the norm
//     here. Summing took the amount agreement from 24 of 40 to 50 of 50.
//   - demanding exactly one dead end, which failed 15 of 40 fills. The extra
//     dead ends are fee takers, not users, and the next block names them.
//
// A rule that is mostly right selects the rest of the row by transaction
// shape, which is the defect behind both #3193 and #3217, so the 2 of 50 the
// rule does not resolve must stay unpriced rather than be guessed at.
//
// WHAT THE OTHER DEAD ENDS ARE, measured over 60 fills:
//
//	robinhoodTokenFee  a CONTRACT (15 kB of code), a dead end in 13 of 60
//	                   fills and never the user, taking the user's own token
//	                   at 101, 204 or 309 bps, on Robinhood only. Those tiers
//	                   are 1%, 2% and 3%, which is a per-token creator or
//	                   launchpad fee rather than any app's cut: an app fee
//	                   does not come in three per-token tiers on one chain.
//	                   Not attributed to a terminal.
//	the token itself   5 of 60, the sink address IS the token contract, which
//	                   is a transfer tax the token levies on every holder.
//	                   Belongs in the pool or other cost, never in a fee.
//
// NO APP-FEE TRANSFER EXISTS ON EITHER LEG, and that is NOT the same as the
// app taking no fee. The deposit carries exactly one token transfer
// (ComputeBudget, ComputeBudget, Token, Memo on all 50 read), so nothing is
// skimmed on the way in, and the only non-user sinks on the way out are the
// two above.
//
// But a fee an integrator sets and the bridge takes inside its QUOTE leaves
// no transfer to find: it would sit in the bridge residual while the column
// read 0, and a reader comparing that against FOMO's Relay rows at about 50
// bps would conclude this route is cheaper in app fees when the fee had only
// moved. So the terminal component here is published as NOT MEASURED, not as
// zero, with the note that any charge by the app is inside the bridge's price
// and counted in the bridge column.
//
// The obvious signal does not resolve it. The explorer's inputAmountUsd minus
// amountInUsd has a median of 144 bps but runs from -528 to +1188, and only
// 12% of 198 rows land between 30 and 70 bps; a fee cannot be negative, so
// that gap is two valuations of the same input disagreeing rather than a fee.
//
// MOBULA'S OWN TAKE on the sell direction, 57 bps median over 210 intents
// with p10 31 and p90 68. What that figure covers took two wrong readings to
// pin down, so the route is written out: over 201 intents, originToken is
// NATIVE in 201, inputToken is an EVM token in 199, and destinationToken is a
// dollar stable on Solana in 200, with originToken never equal to inputToken.
// So the user sells a token into the native coin, the native coin is bridged,
// and a stable arrives.
//
// The 57 bps is (amountInUsd - amountOutUsd) / amountInUsd, which starts from
// the NATIVE amount, so it excludes the sale and is bridge-only. But it is
// native in, not stable in, so it is NOT the same pair as Pump Bridge's USDC
// in and must not be quoted as like-for-like against its 0.05 plus 40 to 45
// bps. Its tightness, against the 131 to 537 spread of the token-delivering
// direction, is what a schedule looks like rather than pool impact.
//
// This also explains the quote gap dismissed above: every row has a sale
// stage, so those 156 bps are the cost of THAT SALE. The verdict (not a fee)
// was right and the reason (two valuations disagreeing) was wrong.
//
// It still cannot be split into bridge and app, which is the point above.
const robinhoodTokenFee = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"

const solanaChainID = 792703809

// applyRPCOverrides prepends the endpoints of EVM_RPC_<CHAIN> (comma
// separated) to a chain's list, so a keyed endpoint that serves past
// state (Alchemy's BNB node serves eth_getBalance at any block; the
// public BSC nodes refuse the previous block) is tried first and the
// public ones stay as fallback. The router feed stays on whatever is
// first too; a keyed node that rejects a call falls through.
func applyRPCOverrides() {
	for i := range originChains {
		v := os.Getenv("EVM_RPC_" + strings.ToUpper(originChains[i].slug))
		if v == "" {
			continue
		}
		var urls []string
		for _, u := range strings.Split(v, ",") {
			if u = strings.TrimSpace(u); u != "" {
				urls = append(urls, u)
			}
		}
		originChains[i].rpc = append(urls, originChains[i].rpc...)
		log.Printf("[evm] %s: %d endpoint(s) from EVM_RPC_%s ahead of the public ones", originChains[i].slug, len(urls), strings.ToUpper(originChains[i].slug))
	}
}

// logsRPC: the endpoints for a wide eth_getLogs, the ones that cap the
// range (Alchemy's free tier: 10 blocks) moved last so no call is wasted
// on them; a keyed QuickNode stays first.
func (c originChain) logsRPC() []string {
	var first, last []string
	for _, u := range c.rpc {
		if strings.Contains(u, "alchemy.com") {
			last = append(last, u)
		} else {
			first = append(first, u)
		}
	}
	return append(first, last...)
}

// traceRPC: the endpoints that may serve debug_traceTransaction (Alchemy's
// free tier does not).
func (c originChain) traceRPC() []string {
	var out []string
	for _, u := range c.rpc {
		if !strings.Contains(u, "alchemy.com") {
			out = append(out, u)
		}
	}
	return out
}

func chainByID(id int64) *originChain {
	for i := range originChains {
		if originChains[i].id == id {
			return &originChains[i]
		}
	}
	return nil
}

// rowSlug: the bench row a request belongs to. Requests settling on
// Solana are the app's funding leg (`<app>-funding`); requests leaving
// Solana for a token on another chain are the app's trading on that
// chain (`<app>-<chain>`).
func (x relayRequest) rowSlug() string {
	if x.Funding {
		return x.App + "-funding"
	}
	if x.DestChain == "" {
		if x.InIsToken && x.Chain != "" && x.Chain != "solana" {
			return x.App + "-" + x.Chain // a sale of a token on the origin chain, settled on Solana
		}
		return x.App + "-funding"
	}
	return x.App + "-" + x.DestChain
}

// relayRequest is one settled (or failed) Relay request of a cohort app.
type relayRequest struct {
	ID            string  `json:"id"`
	App           string  `json:"app"`
	Chain         string  `json:"chain"`                   // origin chain slug ("solana" when leaving Solana)
	DestChain     string  `json:"dest_chain"`              // destination chain slug when not Solana
	TokenOut      string  `json:"token_out"`               // destination token address when not Solana
	Funding       bool    `json:"funding,omitempty"`       // the gas coin (or Arc's USDC) delivered to the user's wallet on the destination: a funding leg, not a trade
	OutValueWei   string  `json:"out_value_wei,omitempty"` // native amount delivered on the destination (Funding)
	Status        string  `json:"status"`
	User          string  `json:"user"`      // origin address
	Recipient     string  `json:"recipient"` // destination wallet
	InTx          string  `json:"in_tx"`
	OutTx         string  `json:"out_tx"` // destination transaction (Solana signature or EVM hash)
	UsdIn         float64 `json:"usd_in"`
	UsdOut        float64 `json:"usd_out"` // Relay's own valuation of the output, cross-check only
	AppFeeUsd     float64 `json:"app_fee_usd"`
	RelayFeeUsd   float64 `json:"relay_fee_usd"`
	DestGasUsd    float64 `json:"dest_gas_usd,omitempty"`
	RelayFixedUsd float64 `json:"relay_fixed_usd,omitempty"` // Relay's fixed + price fees from its breakdown // destination gas Relay charged the user (actual execution when reported, else the quoted gas fee): network cost
	OutIsToken    bool    `json:"out_is_token"`              // Solana side delivers a token (not SOL / a stable)
	InIsToken     bool    `json:"in_is_token"`               // origin side was a token (not the gas coin / a stable): usd_in is Relay's valuation, not an on-chain mid
	TokenIn       string  `json:"token_in"`                  // origin token address when InIsToken
	Created       int64   `json:"created"`
}

type relayResp struct {
	Requests     []json.RawMessage `json:"requests"`
	Continuation string            `json:"continuation"`
}

type relayRaw struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	User      string `json:"user"`
	Recipient string `json:"recipient"`
	CreatedAt string `json:"createdAt"`
	Data      struct {
		Referrer string `json:"referrer"`
		AppFees  []struct {
			Recipient string `json:"recipient"`
			Bps       string `json:"bps"`
			AmountUsd string `json:"amountUsd"`
		} `json:"appFees"`
		InTxs  []relayTx `json:"inTxs"`
		OutTxs []relayTx `json:"outTxs"`
		// Relay's own fee breakdown, USD: gas (destination execution), fixed (the relayer), price (the swap).
		FeesUsd map[string]string `json:"feesUsd"`
		// What actually happened, USD, signed from the user's side: execution (gas, negative), app, swap, relay.
		ExpandedPriceImpact struct {
			Actual map[string]struct {
				Usd string `json:"usd"`
			} `json:"actual"`
		} `json:"expandedPriceImpact"`
		Metadata struct {
			CurrencyIn  relayAmount `json:"currencyIn"`
			CurrencyOut relayAmount `json:"currencyOut"`
		} `json:"metadata"`
		FeeSponsorship struct {
			Quoted struct {
				Components map[string]struct {
					Total struct {
						AmountUsd string `json:"amountUsd"`
					} `json:"total"`
					UserPays struct {
						AmountUsd string `json:"amountUsd"`
					} `json:"userPays"`
					Sponsored struct {
						AmountUsd string `json:"amountUsd"`
					} `json:"sponsored"`
				} `json:"components"`
			} `json:"quoted"`
		} `json:"feeSponsorship"`
	} `json:"data"`
}

type relayTx struct {
	ChainID int64  `json:"chainId"`
	Hash    string `json:"hash"`
	Data    struct {
		To    string `json:"to"`
		Data  string `json:"data"`
		Value string `json:"value"` // wei, decimal string
	} `json:"data"`
}

type relayAmount struct {
	Currency struct {
		ChainID int64  `json:"chainId"`
		Address string `json:"address"`
		Symbol  string `json:"symbol"`
	} `json:"currency"`
	AmountUsd string `json:"amountUsd"`
}

func f64(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }

// xfeed polls Relay's public requests feed per origin chain and keeps,
// per app and per tick, the counts and a reservoir of successful
// settlements on Solana, like the WebSocket feed does for native swaps.
type xfeed struct {
	http     *http.Client
	mu       sync.Mutex
	seen     map[string]int64 // request id -> first seen (dedupe across polls)
	box      map[string]*xinbox
	ok       map[string]int
	last     time.Time
	up       bool
	answered bool                        // a poll of this round got a page from Relay (read and reset by run)
	pending  map[string]pendingReq       // app:id -> the request as met before it was final (re-fetched by id each round)
	funded   map[string]map[string]int64 // app -> wallet funded on another chain -> time, drained into the state each tick
	newest   map[string]int64            // app:origin -> created of the newest final request counted (persisted for the next instance)
	resume   map[string]int64            // the previous instance's newest, read only: the first walk stops there (never the live map, which the walk itself advances)
}

// pendingReq: a request met on the feed before it was final; re-read by id
// on the next rounds until final (refunds finalise last) or forgotten.
type pendingReq struct {
	app     xchainApp
	chain   originChain
	created int64
	since   int64
}

type xinbox struct {
	seen, failed int
	errs         map[string]int
	reservoir    []relayRequest
	total        int
}

func newXfeed(httpc *http.Client, newest map[string]int64) *xfeed {
	n, r := map[string]int64{}, map[string]int64{}
	for k, v := range newest {
		n[k], r[k] = v, v
	}
	return &xfeed{http: httpc, seen: map[string]int64{}, box: map[string]*xinbox{}, ok: map[string]int{}, pending: map[string]pendingReq{}, funded: map[string]map[string]int64{}, newest: n, resume: r}
}

// xchainRows: the row names the Relay feed owns.
//
// A slug that evmTerminals also declares is NOT emitted here. Both producers
// record into the same state under the same name, so a collision does not
// average or sum, it lets whichever row is written last win, silently and
// differently from one tick to the next.
//
// That is not hypothetical: adding the six pump.fun bridge rows in #3141 and
// #3143 collided with the Relay rows this builds, and the published JSON
// carried pump-fun-bnb, -base, -arc, -robinhood, -megaeth and -xlayer twice
// each, 72 entries where 66 were intended, with nothing else in the file
// duplicated.
//
// The first fix was to drop the Relay row on any chain the bridge covers. That
// resolved the collision by losing a measurement: the residual Relay flow went
// unrecorded, and with it half of the comparison pump's own announcement is
// about. The bridge rows are now named for their route instead
// (pump-bridge-<chain>), so nothing is contested and both routes publish. This
// guard stays because a collision is worse than a drop, but it should never
// fire again; a test asserts it drops nothing.
func xchainRows() []string {
	var out []string
	for _, a := range xchainApps {
		out = append(out, a.Slug+"-funding")
		if a.FundingOnly {
			continue
		}
		for _, c := range originChains {
			if relaySkips[c.slug] {
				continue
			}
			slug := a.Slug + "-" + c.slug
			if nativeOwnsSlug(slug) {
				continue
			}
			out = append(out, slug)
		}
	}
	return out
}

// nativeOwnsSlug: whether an evmTerminal row already publishes under this name.
func nativeOwnsSlug(slug string) bool {
	for _, t := range evmTerminals {
		if t.Slug == slug {
			return true
		}
	}
	return false
}

// seedFundedFromRelay walks a funding-only app's public requests (every
// origin) back about a day at start (200 pages) when the state holds fewer
// than 5,000 of its wallets, so the app's row on a shared router knows the
// users still trading from an earlier bridge leg.
func seedFundedFromRelay(ctx context.Context, httpc *http.Client, st *State) {
	for _, a := range xchainApps {
		if !a.FundingOnly || a.Referrer == "" {
			continue
		}
		if st.Funded == nil {
			st.Funded = map[string]map[string]int64{}
		}
		if len(st.Funded[a.Slug]) >= 5000 {
			continue
		}
		if st.Funded[a.Slug] == nil {
			st.Funded[a.Slug] = map[string]int64{}
		}
		cont, got := "", 0
		for page := 0; page < 200; page++ { // about three days of the app's requests
			url := fmt.Sprintf("https://api.relay.link/requests/v2?limit=50&referrer=%s", a.Referrer) // every origin: both ends of every leg are the app's wallets
			if cont != "" {
				url += "&continuation=" + cont
			}
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0 (+https://openchainbench.com)")
			req.Header.Set("Accept", "application/json")
			resp, err := httpc.Do(req)
			if err != nil {
				break
			}
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
			resp.Body.Close()
			var rr relayResp
			if resp.StatusCode != 200 || json.Unmarshal(body, &rr) != nil || len(rr.Requests) == 0 {
				break
			}
			for _, raw := range rr.Requests {
				var r relayRaw
				if json.Unmarshal(raw, &r) != nil || r.ID == "" {
					continue
				}
				created := int64(0)
				if t, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil {
					created = t.Unix()
				}
				for _, w := range []string{r.User, r.Recipient} {
					if !strings.HasPrefix(w, "0x") || len(w) != 42 {
						continue
					}
					w = strings.ToLower(w)
					if st.Funded[a.Slug][w] < created {
						st.Funded[a.Slug][w] = created
						got++
					}
				}
			}
			cont = rr.Continuation
			if cont == "" {
				break
			}
		}
		log.Printf("[relay] %s: %d funded wallets seeded from Relay's history (%d known)", a.Slug, got, len(st.Funded[a.Slug]))
	}
}

// newestSnapshot copies the per-feed newest created times for the state.
func (f *xfeed) newestSnapshot() map[string]int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]int64, len(f.newest))
	for k, v := range f.newest {
		out[k] = v
	}
	return out
}

// drainFunded hands the wallets funded since the last tick to the state.
func (f *xfeed) drainFunded() map[string]map[string]int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.funded
	f.funded = map[string]map[string]int64{}
	return out
}

// solanaOrigin is the feed of requests leaving Solana (not an origin
// chain for gas purposes: the deposit is read from the Solana transaction).
var solanaOrigin = originChain{solanaChainID, "solana", nil, ""}

// run polls every interval. Each poll walks each origin chain's feed
// (newest first, 50 per page) until it meets a request already seen or
// runs out of pages; every new request of a cohort app is counted and,
// when it settled a token on Solana, offered to the reservoir.
func (f *xfeed) run(ctx context.Context, interval time.Duration) {
	for ctx.Err() == nil {
		n := f.poll(ctx, solanaOrigin)
		for _, c := range originChains {
			n += f.poll(ctx, c)
		}
		n += f.refetchPending(ctx)
		f.mu.Lock()
		// Up only when Relay answered at least one poll this round: a dead
		// API must not read as a quiet one (the rows would age with no sign).
		f.up = f.answered
		if f.answered {
			f.last = time.Now()
		}
		f.answered = false
		gRelayFeed.Set(b2f(f.up))
		// forget ids older than a day
		cut := time.Now().Add(-24 * time.Hour).Unix()
		for id, t := range f.seen {
			if t < cut {
				delete(f.seen, id)
			}
		}
		f.mu.Unlock()
		if n > 0 {
			log.Printf("[relay] %d new requests", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func (f *xfeed) poll(ctx context.Context, c originChain) int {
	added := 0
	// One walk per stream: the referrer apps each have their own filtered
	// stream; the fee-recipient apps (FOMO, pump.fun app, Phantom) all
	// read the unfiltered stream of the origin, walked once for them all
	// (seen, resume and pending stay per app).
	type stream struct {
		referrer string
		apps     []xchainApp
	}
	var streams []stream
	var shared stream
	for _, a := range xchainApps {
		if a.Referrer == "" && len(a.FeeRecipients) == 0 {
			continue
		}
		if a.Referrer != "" {
			streams = append(streams, stream{referrer: a.Referrer, apps: []xchainApp{a}})
		} else {
			shared.apps = append(shared.apps, a)
		}
	}
	if len(shared.apps) > 0 {
		streams = append([]stream{shared}, streams...)
	}
	for _, st := range streams {
		cont := ""
		const pages = 60 // 3,000 requests a round: one page in steady state, the gap of a deploy (build, seed walk) after a restart; logged when it binds
		for page := 0; page < pages; page++ {
			url := fmt.Sprintf("https://api.relay.link/requests/v2?originChainId=%d&limit=50", c.id)
			if st.referrer != "" {
				url += "&referrer=" + st.referrer
			}
			if cont != "" {
				url += "&continuation=" + cont
			}
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0 (+https://openchainbench.com)")
			req.Header.Set("Accept", "application/json")
			resp, err := f.http.Do(req)
			if err != nil {
				return added
			}
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
			resp.Body.Close()
			if resp.StatusCode != 200 {
				return added
			}
			var rr relayResp
			if json.Unmarshal(body, &rr) != nil {
				return added
			}
			f.answered = true
			stop := len(rr.Requests) == 0
			for _, raw := range rr.Requests {
				var r relayRaw
				if json.Unmarshal(raw, &r) != nil || r.ID == "" {
					continue
				}
				created := int64(0)
				if t, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil {
					created = t.Unix()
				}
				// Seen is per app: one app's earlier walk of the same stream
				// must not hide the request from another; the walk stops
				// once every app of the stream knows the request.
				allKnown := true
				for _, a := range st.apps {
					key := a.Slug + ":" + r.ID
					f.mu.Lock()
					_, known := f.seen[key]
					if !known && created > 0 && created <= f.resume[a.Slug+":"+c.slug] {
						known = true // counted by the previous instance (the state carries its newest created)
					}
					f.mu.Unlock()
					if known {
						continue
					}
					allKnown = false
					if r.Status == "pending" || r.Status == "depositing" {
						// Not final yet: remembered and re-read by id on the next
						// rounds (a refund finalises last and would otherwise sit
						// behind the first known request the walk stops at).
						f.mu.Lock()
						if _, ok := f.pending[key]; !ok {
							f.pending[key] = pendingReq{app: a, chain: c, created: created, since: time.Now().Unix()}
						}
						f.mu.Unlock()
						continue
					}
					if f.count(a, c, r) {
						added++
					}
				}
				if allKnown {
					stop = true
				}
			}
			cont = rr.Continuation
			if stop || cont == "" {
				break
			}
			if page == pages-1 {
				var names []string
				for _, a := range st.apps {
					names = append(names, a.Slug)
				}
				log.Printf("[relay] %s from %s: page budget reached (%d pages), older requests of this round skipped", strings.Join(names, "+"), c.slug, pages)
			}
		}
	}
	return added
}

// count takes one final request: marks it seen for the app, records the
// wallet it funded, and feeds the row's counters and reservoir. True when
// the request is the app's.
func (f *xfeed) count(a xchainApp, c originChain, r relayRaw) bool {
	key := a.Slug + ":" + r.ID
	x, ok := classify(a, c, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen[key] = time.Now().Unix()
	delete(f.pending, key)
	if t, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil {
		if nk := a.Slug + ":" + c.slug; t.Unix() > f.newest[nk] {
			f.newest[nk] = t.Unix()
		}
	}
	if a.FundingOnly && a.Referrer != "" {
		// Every request of the referrer feed is the app's: both ends of
		// any leg (Solana to EVM, EVM to Solana, EVM to EVM) name one of
		// its EVM wallets.
		for _, w := range []string{r.User, r.Recipient} {
			if strings.HasPrefix(w, "0x") && len(w) == 42 {
				if f.funded[a.Slug] == nil {
					f.funded[a.Slug] = map[string]int64{}
				}
				f.funded[a.Slug][strings.ToLower(w)] = time.Now().Unix()
			}
		}
	}
	if !ok {
		return false
	}
	b := f.box[x.rowSlug()]
	if b == nil {
		b = &xinbox{}
		f.box[x.rowSlug()] = b
	}
	b.seen++
	if x.Status != "success" {
		b.failed++
		if b.errs == nil {
			b.errs = map[string]int{}
		}
		b.errs[x.Status]++
	} else if x.OutTx != "" {
		b.total++
		if len(b.reservoir) < reservoirSize {
			b.reservoir = append(b.reservoir, x)
		} else if j := rand.Intn(b.total); j < reservoirSize {
			b.reservoir[j] = x
		}
	}
	return true
}

// refetchPending re-reads the requests met before they were final, by id
// (Relay's /requests/v2?id=), at most 60 a round; final ones are counted,
// ones pending for over 30 minutes are forgotten.
func (f *xfeed) refetchPending(ctx context.Context) (counted int) {
	f.mu.Lock()
	keys := make([]string, 0, len(f.pending))
	for k := range f.pending {
		keys = append(keys, k)
	}
	f.mu.Unlock()
	cut := time.Now().Add(-30 * time.Minute).Unix()
	n := 0
	for _, k := range keys {
		f.mu.Lock()
		p, ok := f.pending[k]
		f.mu.Unlock()
		if !ok {
			continue
		}
		if p.since < cut {
			f.mu.Lock()
			delete(f.pending, k)
			f.mu.Unlock()
			continue
		}
		if n >= 60 {
			break
		}
		n++
		id := strings.TrimPrefix(k, p.app.Slug+":")
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.relay.link/requests/v2?id="+id, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0 (+https://openchainbench.com)")
		req.Header.Set("Accept", "application/json")
		resp, err := f.http.Do(req)
		if err != nil {
			return counted
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode != 200 {
			continue
		}
		var rr relayResp
		if json.Unmarshal(body, &rr) != nil || len(rr.Requests) == 0 {
			continue
		}
		var r relayRaw
		if json.Unmarshal(rr.Requests[0], &r) != nil || r.ID == "" || r.Status == "pending" || r.Status == "depositing" {
			continue
		}
		if f.count(p.app, p.chain, r) {
			counted++
		}
	}
	return counted
}

// Identifier liveness. An app is recognised in Relay's feed by its fee
// recipient or referrer, and when one falls out of use nothing errors: the
// app's rows simply stop appearing, and an absent row reads as "the app does
// not do this" rather than "we stopped seeing it". Phantom's recipient moved
// to 0x037da4f7… and its rows were empty until someone asked why the page
// looked thin (2026-10-23). Every declared identifier is published from start
// at 0 so a dead one is visible as never seen, not as a missing series.
var (
	cAppIdentifier = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "tfq_app_identifier_matches_total",
		Help: "Relay requests matched to an app by each declared identifier (fee recipient address, or referrer:<name>). Every declared identifier starts at 0: one whose increase over 24 h is 0 while the app's others move is a recipient or referrer the app no longer uses, and its rows are going blind",
	}, []string{"app", "identifier"})
	gAppIdentifierLast = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_app_identifier_last_seen_unix",
		Help: "Unix time an app's declared identifier last matched a Relay request; 0 = not seen since this process started",
	}, []string{"app", "identifier"})
)

func init() {
	prometheus.MustRegister(cAppIdentifier, gAppIdentifierLast)
	for _, a := range xchainApps {
		for _, id := range appIdentifiers(a) {
			cAppIdentifier.WithLabelValues(a.Slug, id).Add(0)
			gAppIdentifierLast.WithLabelValues(a.Slug, id).Set(0)
		}
	}
}

// appIdentifiers lists what an app is recognised by, as the labels above use.
func appIdentifiers(a xchainApp) []string {
	ids := append([]string(nil), a.FeeRecipients...)
	if a.Referrer != "" {
		ids = append(ids, "referrer:"+a.Referrer)
	}
	return ids
}

func noteIdentifier(app, id string) {
	cAppIdentifier.WithLabelValues(app, id).Inc()
	gAppIdentifierLast.WithLabelValues(app, id).Set(float64(time.Now().Unix()))
}

// classify decides whether a Relay request belongs to the app (its fee
// recipient or referrer) and reduces it to the figures the bench needs.
func classify(a xchainApp, c originChain, r relayRaw) (relayRequest, bool) {
	mine := a.Referrer != "" && r.Data.Referrer == a.Referrer
	if mine {
		noteIdentifier(a.Slug, "referrer:"+a.Referrer)
	}
	appFee := 0.0
	for _, fee := range r.Data.AppFees {
		rec := strings.ToLower(fee.Recipient)
		for _, want := range a.FeeRecipients {
			if rec == want {
				mine = true
				noteIdentifier(a.Slug, want)
			}
		}
		appFee += f64(fee.AmountUsd)
	}
	if a.Referrer != "" {
		mine = true // the feed itself was filtered on the referrer
	}
	if !mine {
		return relayRequest{}, false
	}
	x := relayRequest{ID: r.ID, App: a.Slug, Chain: c.slug, Status: r.Status, User: r.User, Recipient: r.Recipient, UsdIn: f64(r.Data.Metadata.CurrencyIn.AmountUsd), UsdOut: f64(r.Data.Metadata.CurrencyOut.AmountUsd)}
	if t, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err == nil {
		x.Created = t.Unix()
	}
	for _, tx := range r.Data.InTxs {
		if tx.Hash != "" {
			x.InTx = tx.Hash
			break
		}
	}
	out := r.Data.Metadata.CurrencyOut.Currency
	if out.ChainID != solanaChainID {
		// Leaving Solana for a token elsewhere: only chains we can read.
		dc := chainByID(out.ChainID)
		if c.id != solanaChainID || dc == nil {
			return relayRequest{}, false
		}
		x.DestChain, x.TokenOut = dc.slug, strings.ToLower(out.Address)
		if x.TokenOut == "" || x.TokenOut == "0x0000000000000000000000000000000000000000" {
			// The gas coin delivered to the user's wallet on the destination
			// (BasedBot funds its users' Robinhood Chain, BNB, Base and
			// Ethereum wallets from Solana this way; Arc's USDC is its gas):
			// a funding leg, priced from the native amount delivered.
			x.Funding, x.TokenOut = true, ""
		}
	} else if c.id == solanaChainID {
		return relayRequest{}, false // Solana to Solana: a native swap, not a bridge
	}
	for _, tx := range r.Data.OutTxs {
		if tx.ChainID == out.ChainID && tx.Hash != "" {
			x.OutTx, x.OutValueWei = tx.Hash, tx.Data.Value
			break
		}
	}
	x.OutIsToken = out.ChainID == solanaChainID && out.Address != "" && out.Address != "11111111111111111111111111111111" && out.Address != wsolMint && !stableMints[out.Address]
	if a.FundingOnly && !x.Funding && x.DestChain != "" {
		return relayRequest{}, false // the app's trades are read on the chain itself, not from the bridge
	}
	in := r.Data.Metadata.CurrencyIn.Currency
	inAddr := strings.ToLower(in.Address)
	sym := strings.ToUpper(in.Symbol)
	switch {
	case in.Address == "0x0000000000000000000000000000000000000000" || in.Address == "11111111111111111111111111111111":
		x.InIsToken = false
	case sym == "ETH" || sym == "BNB" || sym == "WETH" || sym == "WBNB" || sym == "SOL":
		x.InIsToken = false
	case sym == "USDC" || sym == "USDT" || sym == "USDG" || sym == "USD1" || sym == "DAI" || sym == "USDS" || sym == "USDE" || sym == "PYUSD" || sym == "USDC.E" || sym == "USDBC":
		// A ticker is a string anyone can mint. On a chain whose stables
		// are listed the address decides: "UpSideDownCat", symbol USDC,
		// eighteen decimals, on Arc was taken for dollars, and a token
		// sale went on the board as a $96.61 funding deposit that lost
		// 337 bps against a swap that had actually delivered $99.31.
		if x.Chain == "solana" {
			x.InIsToken = !stableMints[in.Address]
		} else if list, known := stableAddrs[x.Chain]; known {
			x.InIsToken = !list[inAddr]
		} else {
			// No list for this chain (HyperEVM): a ticker alone does not
			// make a dollar. Kept, shown, not counted, like any token.
			x.InIsToken = true
		}
	default:
		x.InIsToken = true
	}
	if x.InIsToken {
		x.TokenIn = inAddr
	}
	// What the user actually paid after Relay's sponsorship: the app's
	// fee and Relay's own components (execution on the destination, the
	// swap, the relay service, rent). When the quote carries no
	// sponsorship breakdown, the app fee is the quoted one.
	comps := r.Data.FeeSponsorship.Quoted.Components
	destSponsored := false
	if len(comps) > 0 {
		if app, ok := comps["app"]; ok {
			x.AppFeeUsd = f64(app.UserPays.AmountUsd)
		} else {
			x.AppFeeUsd = appFee
		}
		for _, k := range []string{"swap", "relay", "rent"} {
			if v, ok := comps[k]; ok {
				x.RelayFeeUsd += f64(v.UserPays.AmountUsd)
			}
		}
		if v, ok := comps["execution"]; ok {
			x.DestGasUsd = f64(v.UserPays.AmountUsd) // the quoted gas the user paid; replaced by the actual below when reported
			// Relay says the user pays nothing and the app pays it all:
			// then zero is the answer, and the fallbacks below must not
			// put the gas back. Every fully sponsored pump.fun funding
			// row in the window read negative by exactly that gas.
			destSponsored = f64(v.UserPays.AmountUsd) == 0 && f64(v.Sponsored.AmountUsd) > 0
		}
	} else {
		x.AppFeeUsd = appFee
	}
	// The gas actually spent on the destination (Relay's actual execution),
	// less the part the app sponsored: what the user really paid for gas.
	// The quoted gas above overstates it (quoted 0.204 $, actual 0.126 $ on
	// a pump.fun app buy on Robinhood Chain); the difference is Relay's.
	if v, ok := r.Data.ExpandedPriceImpact.Actual["execution"]; ok && f64(v.Usd) != 0 {
		actual := math.Abs(f64(v.Usd))
		if c, ok := comps["execution"]; ok {
			actual -= f64(c.Sponsored.AmountUsd)
		}
		if actual < 0 {
			actual = 0
		}
		x.DestGasUsd = actual
		// And never more than Relay quoted the user for it. The actual
		// execution figure is the solver's own gas, and on a subsidised
		// request the solver can spend far more than the user was quoted:
		// a $5.68 pump.fun buy on HyperEVM had actual execution $0.424
		// against a quote of $0.075 to the user, whose whole shortfall in
		// and out was $0.23 — so the row charged 737 bps of gas the user
		// never paid and the pool went to -196. The user's cost is bounded
		// by the quote they accepted; the overrun is Relay's.
		if c, ok := comps["execution"]; ok {
			if quoted := f64(c.UserPays.AmountUsd); quoted > 0 && x.DestGasUsd > quoted {
				x.DestGasUsd = quoted
			}
		}
	}
	for _, k := range []string{"fixed", "price"} {
		if v, ok := r.Data.FeesUsd[k]; ok {
			x.RelayFixedUsd += math.Abs(f64(v))
		}
	}
	// Relay's breakdown: the destination gas is network cost, not the bridge's take.
	if x.DestGasUsd == 0 && !destSponsored {
		if v, ok := r.Data.ExpandedPriceImpact.Actual["execution"]; ok {
			x.DestGasUsd = math.Abs(f64(v.Usd))
		} else if g, ok := r.Data.FeesUsd["gas"]; ok {
			x.DestGasUsd = math.Abs(f64(g))
		}
	}
	return x, true
}

func (f *xfeed) drain(slug string) (seen, failed int, errs map[string]int, sample []relayRequest, total int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := f.box[slug]
	if b == nil {
		return
	}
	seen, failed, errs, sample, total = b.seen, b.failed, b.errs, b.reservoir, b.total
	f.box[slug] = &xinbox{}
	f.ok[slug] = total
	return
}

func (f *xfeed) healthy() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.up && time.Since(f.last) < 5*time.Minute
}

// bridgeRow reduces a settlement that delivered SOL or a stable to the
// user (a funding leg) to a Swap: Tokens = the quote received, valued 1:1,
// UserQ = the origin deposit plus its gas, terminal = the app fee, relay =
// what Relay kept (deposit − received − app fee: its fees and its
// spread), network = origin gas. Nil when the user received nothing.
func bridgeRow(t Terminal, x relayRequest, tx *parsedTx, solUSD, gasUSD float64) *Swap {
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n || len(tx.Meta.PostBalances) != n {
		return nil
	}
	// Stable received on token accounts owned by the user, SOL received
	// on the user's own account; the larger of the two in USD is the
	// delivered asset.
	stable := map[string]float64{}
	pre := map[int]float64{}
	for _, b := range tx.Meta.PreTokenBalances {
		if b.Owner == x.Recipient && stableMints[b.Mint] {
			pre[b.AccountIndex] = b.raw() * 1e-6
		}
	}
	for _, b := range tx.Meta.PostTokenBalances {
		if b.Owner == x.Recipient && stableMints[b.Mint] {
			d := b.raw()*1e-6 - pre[b.AccountIndex]
			if d > 0 {
				stable[quoteName(b.Mint)] += d
			}
		}
	}
	sol := 0.0
	for i, k := range msg.AccountKeys {
		if k.Pubkey == x.Recipient {
			sol += float64(int64(tx.Meta.PostBalances[i])-int64(tx.Meta.PreBalances[i])) / 1e9
		}
	}
	quote, recv, q := "", 0.0, 0.0
	for name, v := range stable {
		if v > recv {
			quote, recv, q = name, v, 1
		}
	}
	if sol*solUSD > recv*q {
		quote, recv, q = "SOL", sol, solUSD
	}
	if recv <= 0 || q <= 0 {
		return nil
	}
	sw := &Swap{Method: methodVersion, Sig: x.OutTx, Terminal: t.Slug, Slot: tx.Slot, User: x.Recipient, Side: "buy", Quote: quote, Venue: "relay", Mint: quote, Tokens: recv, QuoteUSD: q, Pools: 0}
	if tx.BlockTime != nil {
		sw.Time = *tx.BlockTime
	}
	sw.UserQ = (x.UsdIn + gasUSD) / q
	sw.TerminalQ = x.AppFeeUsd / q
	sw.NetworkQ = (gasUSD + x.DestGasUsd) / q // origin gas plus the destination gas Relay charged
	relay := x.UsdIn - recv*q - x.AppFeeUsd - x.DestGasUsd
	if relay < 0 {
		relay = 0
	}
	sw.RelayQ = relay / q
	sw.PoolQ = recv
	zero := 0.0
	sw.OtherQ = &zero
	return sw
}

// solanaGiven reads what the user gave on Solana for a request leaving
// it: SOL (lamports delta, the tx fee inside when they paid it) or a
// stable, in USD, plus the fee part apart.
func solanaGiven(tx *parsedTx, user string, solUSD float64) (givenUSD, feeUSD float64, quote string) {
	msg := tx.Transaction.Message
	n := len(msg.AccountKeys)
	if n == 0 || len(tx.Meta.PreBalances) != n || len(tx.Meta.PostBalances) != n {
		return 0, 0, ""
	}
	sol := 0.0
	for i, k := range msg.AccountKeys {
		if k.Pubkey == user {
			sol += float64(int64(tx.Meta.PreBalances[i])-int64(tx.Meta.PostBalances[i])) / 1e9
		}
	}
	if len(msg.AccountKeys) > 0 && msg.AccountKeys[0].Pubkey == user {
		feeUSD = float64(tx.Meta.Fee) / 1e9 * solUSD
	}
	pre := map[int]float64{}
	for _, b := range tx.Meta.PreTokenBalances {
		if b.Owner == user && (stableMints[b.Mint] || b.Mint == wsolMint) {
			pre[b.AccountIndex] = b.raw()
		}
	}
	stable, wsol := 0.0, 0.0
	for _, b := range tx.Meta.PostTokenBalances {
		if b.Owner != user {
			continue
		}
		d := pre[b.AccountIndex] - b.raw()
		if b.Mint == wsolMint {
			wsol += d / 1e9
		} else if stableMints[b.Mint] {
			stable += d / 1e6
		}
	}
	sol += wsol
	if stable*1 > sol*solUSD {
		return stable, feeUSD, "USDC"
	}
	if sol <= 0 {
		return 0, feeUSD, ""
	}
	return sol * solUSD, feeUSD, "SOL"
}

// originGasUSD reads the origin deposit's receipt on the chain's public
// RPC: gasUsed × effectiveGasPrice in the gas token, priced in USD.
func originGasUSD(ctx context.Context, httpc *http.Client, chain string, hash string, gasUSD map[string]float64) (float64, bool) {
	var c *originChain
	for i := range originChains {
		if originChains[i].slug == chain {
			c = &originChains[i]
		}
	}
	if c == nil || hash == "" {
		return 0, false
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": []any{hash}})
	var out struct {
		Result *struct {
			GasUsed           string `json:"gasUsed"`
			EffectiveGasPrice string `json:"effectiveGasPrice"`
		} `json:"result"`
	}
	for _, url := range c.rpc {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 OpenChainBench/1.0")
		resp, err := httpc.Do(req)
		if err != nil {
			continue
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out)
		resp.Body.Close()
		if err == nil && out.Result != nil {
			break
		}
		out.Result = nil
	}
	if out.Result == nil {
		return 0, false
	}
	used, err1 := strconv.ParseUint(strings.TrimPrefix(out.Result.GasUsed, "0x"), 16, 64)
	price, err2 := strconv.ParseUint(strings.TrimPrefix(out.Result.EffectiveGasPrice, "0x"), 16, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	native := float64(used) * float64(price) / 1e18
	if c.gas == "" {
		return native, true // a $1 stable gas token (Arc: USDC, 6 decimals handled by the chain as 18? keep native)
	}
	p, ok := gasUSD[c.gas]
	if !ok || p <= 0 {
		return 0, false
	}
	return native * p, true
}

// gasPrices reads the origin gas tokens' USD prices from Coinbase spot.
func gasPrices(ctx context.Context, httpc *http.Client) map[string]float64 {
	out := map[string]float64{}
	for _, pair := range []string{"ETH-USD", "BNB-USD"} {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.coinbase.com/v2/prices/"+pair+"/spot", nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
		resp, err := httpc.Do(req)
		if err != nil {
			continue
		}
		var cb struct {
			Data struct {
				Amount string `json:"amount"`
			} `json:"data"`
		}
		json.NewDecoder(resp.Body).Decode(&cb)
		resp.Body.Close()
		if p := f64(cb.Data.Amount); p > 0 {
			out[pair] = p
		}
	}
	// HYPE: Hyperliquid's own spot mids (the only liquid print for it).
	if req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.hyperliquid.xyz/info", strings.NewReader(`{"type":"allMids"}`)); err == nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
		if resp, err := httpc.Do(req); err == nil {
			var mids map[string]string
			json.NewDecoder(resp.Body).Decode(&mids)
			resp.Body.Close()
			if p := f64(mids["HYPE"]); p > 0 {
				out["HYPE-USD"] = p
			}
		}
	}
	return out
}
