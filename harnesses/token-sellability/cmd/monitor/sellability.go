// Package main probes whether a token can actually be sold.
//
// The question is not academic: an aggregator can hold the best quote on a
// token nobody can sell out of, and the quote boards would score that as
// quality. This probe answers it from the chain, with no list to trust.
//
// Method. Take a route a user would really sign, from a live aggregator
// quote, and simulate buy, approve and sell in one eth_simulateV1 request.
// State carries between calls, so the buy funds the sell and no storage slot
// has to be guessed. Guessing the balances slot is how this is usually done
// and it fails silently on any non-standard layout, which is precisely the
// population under test.
//
// Two timings, because they mean different things. Selling in the same block
// as the buy is the only way to hold the market still, but it also trips
// every anti-bot cooldown, which is a common and often honest protection. A
// token that fails the same-block sell and passes the delayed one is not a
// honeypot, and scoring it as one would be this bench's largest source of
// false accusations.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// Two behaviours of the node cost an evening each and are not in any
// documentation, so they are recorded here rather than in a commit message.
//
// Overriding the block NUMBER makes the node return a well-formed block with
// an EMPTY calls array and no error. Not a revert, not a failure: the work
// silently does not happen. Measured 2026-11-03 at margins of 30 and 100
// blocks ahead of the head, both while the override was still in the future.
// So this file never sets `number`, and the leg count is checked against
// what was sent on every probe.
//
// The node also fills skipped blocks at 12 seconds each, Ethereum's default,
// while this chain produces one every 0.1024 s. Pricing a gap at the real
// block time is rejected as out of order. Advancing by appending empty
// blockStateCalls avoids the arithmetic entirely: each one is a block.
const (
	nativeSentinel = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
	approveSel     = "0x095ea7b3"
	maxUint256     = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
)

// Verdict is what one probe concluded about one token.
type Verdict string

const (
	// Sellable: the sell leg succeeded.
	Sellable Verdict = "sellable"
	// Unsellable: the buy succeeded and the sell reverted.
	Unsellable Verdict = "unsellable"
	// NoRoute: nobody quoted a way in or out, so the token is out of scope
	// rather than unsafe. An aggregator cannot route you into what it
	// cannot price.
	NoRoute Verdict = "no_route"
	// Inconclusive: the probe itself did not produce an answer. This is a
	// distinct verdict on purpose. A probe that cannot tell must say so
	// rather than fall back to one of the real outcomes, because both of
	// them are claims about somebody's token.
	Inconclusive Verdict = "inconclusive"
)

// Quote is the part of an aggregator's answer this probe needs: the amount,
// and the transaction a user would sign to get it.
type Quote struct {
	AmountOut *big.Int
	To        string
	Data      string
	Value     string
}

// Probe holds what one token's examination produced, including the reason
// when it produced nothing.
type Probe struct {
	Token     string
	SameBlock Verdict
	Delayed   Verdict
	Reason    string
	Bought    *big.Int
	// Why the sell reverted, per tier, as the chain stated it. Empty when
	// the token sold. An unsellable verdict without a reason is an
	// accusation with nothing behind it.
	SameBlockWhy string
	DelayedWhy   string
}

// Cooldown reports the one pattern that must never be published as a
// honeypot: the sell fails when attempted in the same block and succeeds a
// few blocks later. That is an anti-bot timer, not a trap.
func (p Probe) Cooldown() bool {
	return p.SameBlock == Unsellable && p.Delayed == Sellable
}

// Confirmed reports a token that could not be sold at either timing, which
// is the only shape this bench will name.
func (p Probe) Confirmed() bool {
	return p.SameBlock == Unsellable && p.Delayed == Unsellable
}

type rpcClient struct {
	url    string
	client *http.Client
}

func newRPC(url string) *rpcClient {
	return &rpcClient{url: url, client: &http.Client{Timeout: 90 * time.Second}}
}

func (c *rpcClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	req, err := http.NewRequestWithContext(ctx, "POST", c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("unreadable response: %w", err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("rpc: %s", out.Error.Message)
	}
	return out.Result, nil
}

// approveData builds approve(spender, 2^256-1) for the router that will take
// the token on the sell leg.
func approveData(spender string) string {
	s := strings.ToLower(strings.TrimPrefix(spender, "0x"))
	return approveSel + strings.Repeat("0", 64-len(s)) + s + maxUint256
}

// hexAmount normalises the decimal strings aggregators return into the hex
// the node requires. A decimal here is rejected with "cannot unmarshal hex
// string without 0x prefix", which reads like a node problem and is not.
func hexAmount(v string) string {
	if v == "" {
		return "0x0"
	}
	if strings.HasPrefix(v, "0x") {
		return v
	}
	n, ok := new(big.Int).SetString(v, 10)
	if !ok {
		return "0x0"
	}
	return "0x" + n.Text(16)
}

type simCall struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Value string `json:"value"`
	Data  string `json:"data"`
}

type simBlock struct {
	StateOverrides map[string]map[string]string `json:"stateOverrides,omitempty"`
	Calls          []simCall                    `json:"calls"`
}

type simResult struct {
	Calls []simCallResult `json:"calls"`
}

// simCallResult keeps the return data, because a reverting call says why it
// reverted and this probe used to throw that away.
//
// It matters more here than in most places: an unsellable verdict is a claim
// about somebody's token, and WETH was recorded unsellable on 2026-11-05 on a
// chain where it demonstrably sells. Without the reason there was nothing to
// read afterwards, and the failure did not reproduce from outside across 65
// attempts. The instrument has to carry its own evidence.
type simCallResult struct {
	Status     string `json:"status"`
	GasUsed    string `json:"gasUsed"`
	ReturnData string `json:"returnData"`
	Error      *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// revertReason renders why a call failed, in one short line fit for a log and
// a label. Solidity's Error(string) is decoded; anything else is named by its
// selector rather than guessed at.
func (r simCallResult) revertReason() string {
	if r.Error != nil && r.Error.Message != "" {
		return trimReason(r.Error.Message)
	}
	d := strings.TrimPrefix(r.ReturnData, "0x")
	if d == "" {
		return "reverted with no data"
	}
	// Error(string): selector, offset, length, then the bytes.
	if strings.HasPrefix(d, "08c379a0") && len(d) >= 136 {
		n, ok := new(big.Int).SetString(d[72:136], 16)
		if ok && n.Sign() > 0 && 136+int(n.Int64())*2 <= len(d) {
			b, err := hex.DecodeString(d[136 : 136+int(n.Int64())*2])
			if err == nil {
				return trimReason(string(b))
			}
		}
	}
	if strings.HasPrefix(d, "4e487b71") {
		return "panic 0x" + d[len(d)-2:]
	}
	if len(d) >= 8 {
		return "custom error 0x" + d[:8]
	}
	return "reverted"
}

func trimReason(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// simulate runs the blocks and returns the legs of the LAST one.
//
// It refuses rather than guesses when the node returns fewer legs than were
// sent: that is the silent-empty-block case above, and reading a status out
// of a short list would publish a revert that never happened.
func (c *rpcClient) simulate(ctx context.Context, blocks []simBlock, wantLast int) ([]simCallResult, error) {
	raw, err := c.call(ctx, "eth_simulateV1", []any{map[string]any{
		"blockStateCalls": blocks,
		"validation":      false,
		"traceTransfers":  true,
	}, "latest"})
	if err != nil {
		return nil, err
	}
	var res []simResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("unreadable simulation: %w", err)
	}
	if len(res) == 0 {
		return nil, fmt.Errorf("no blocks returned")
	}
	last := res[len(res)-1]
	if len(last.Calls) != wantLast {
		return nil, fmt.Errorf("node ran %d of %d calls", len(last.Calls), wantLast)
	}
	return last.Calls, nil
}

// oneEther funds the probing address. The amount is irrelevant beyond being
// enough; it is granted by override so no funded wallet is involved and the
// probe can never move real value.
const oneEther = "0xDE0B6B3A7640000"

// balanceSelector is balanceOf(address), with the probing address baked in by
// Received below.
const balanceSelector = "0x70a08231"

// Received simulates the buy and reads the balance it actually produced.
//
// Sizing the sale from the QUOTED amount is wrong on any token that takes a
// cut on transfer, and those are the majority of what this bench looks at:
// PRISM delivered 97.0% of its quote on 2026-11-05, so a sale sized at 98%
// of the quote asked for more than the address held and reverted for lack of
// balance. That reads as "the token refuses to be sold" and it is nothing of
// the kind. A transfer tax is a cost, not a trap, and the two must not share
// a verdict.
//
// It costs one extra simulation per token. Measuring what arrived is the only
// way to tell a tax from a refusal, and the whole board rests on that
// distinction.
func (c *rpcClient) Received(ctx context.Context, from, token string, buy Quote) (*big.Int, error) {
	addr := strings.ToLower(strings.TrimPrefix(from, "0x"))
	calls := []simCall{
		{From: from, To: buy.To, Value: hexAmount(buy.Value), Data: buy.Data},
		{From: from, To: token, Value: "0x0",
			Data: balanceSelector + strings.Repeat("0", 64-len(addr)) + addr},
	}
	out, err := c.simulate(ctx, []simBlock{
		{StateOverrides: map[string]map[string]string{from: {"balance": oneEther}},
			Calls: calls},
	}, 2)
	if err != nil {
		return nil, err
	}
	if out[0].Status != "0x1" {
		return nil, fmt.Errorf("buy leg reverted: %s", out[0].revertReason())
	}
	n, ok := new(big.Int).SetString(strings.TrimPrefix(out[1].ReturnData, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("unreadable balance %q", out[1].ReturnData)
	}
	return n, nil
}

// Examine buys the token, approves the sell router and sells, at two
// timings. DelayBlocks is reached by appending empty blocks rather than by
// moving the block number, for the reason recorded at the top of this file.
func Examine(ctx context.Context, c *rpcClient, from, token string, buy, sell Quote, delayBlocks int) Probe {
	p := Probe{Token: token, Bought: buy.AmountOut}
	if buy.To == "" || sell.To == "" {
		p.SameBlock, p.Delayed, p.Reason = NoRoute, NoRoute, "no route in or out"
		return p
	}

	over := map[string]map[string]string{from: {"balance": oneEther}}
	entry := []simCall{
		{From: from, To: buy.To, Value: hexAmount(buy.Value), Data: buy.Data},
		{From: from, To: token, Value: "0x0", Data: approveData(sell.To)},
	}
	exit := simCall{From: from, To: sell.To, Value: hexAmount(sell.Value), Data: sell.Data}

	same, err := c.simulate(ctx, []simBlock{
		{StateOverrides: over, Calls: append(append([]simCall{}, entry...), exit)},
	}, 3)
	if err != nil {
		p.SameBlock, p.Delayed, p.Reason = Inconclusive, Inconclusive, err.Error()
		return p
	}
	if same[0].Status != "0x1" {
		// The buy failing says nothing about sellability, and calling it
		// unsellable would blame the token for a route that never opened.
		p.SameBlock, p.Delayed, p.Reason = NoRoute, NoRoute, "buy leg reverted"
		return p
	}
	p.SameBlock = Sellable
	if same[2].Status != "0x1" {
		p.SameBlock = Unsellable
		p.SameBlockWhy = same[2].revertReason()
	}

	blocks := []simBlock{{StateOverrides: over, Calls: entry}}
	for i := 0; i < delayBlocks; i++ {
		blocks = append(blocks, simBlock{Calls: []simCall{}})
	}
	blocks = append(blocks, simBlock{Calls: []simCall{exit}})

	later, err := c.simulate(ctx, blocks, 1)
	if err != nil {
		p.Delayed, p.Reason = Inconclusive, err.Error()
		return p
	}
	p.Delayed = Sellable
	if later[0].Status != "0x1" {
		p.Delayed = Unsellable
		p.DelayedWhy = later[0].revertReason()
	}
	return p
}

// whyAt names the reason the sale reverted at one tier, for a log line that
// has to say which timing it is talking about.
func (p Probe) whyAt(tier string) string {
	if tier == "same_block" {
		return p.SameBlockWhy
	}
	return p.DelayedWhy
}
