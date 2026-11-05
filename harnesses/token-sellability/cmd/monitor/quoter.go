package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SushiQuoter is the route source for the probe.
//
// One aggregator is enough to establish sellability, because the question is
// whether ANY route out exists, not which is best. Sushi is used because it
// is keyless, it answers on this chain, and it returns the transaction a
// user would sign rather than only an amount: simulating a hand-built
// calldata would test my encoder, not the token.
type SushiQuoter struct {
	sender string
	client *http.Client
	base   string
}

func NewSushiQuoter(sender string) *SushiQuoter {
	return &SushiQuoter{
		sender: sender,
		client: &http.Client{Timeout: 40 * time.Second},
		base:   "https://api.sushi.com/swap/v7/4663",
	}
}

func (q *SushiQuoter) Quote(ctx context.Context, tokenIn, tokenOut, amount string) (Quote, error) {
	v := url.Values{}
	v.Set("tokenIn", tokenIn)
	v.Set("tokenOut", tokenOut)
	v.Set("amount", amount)
	v.Set("maxSlippage", "0.05")
	v.Set("sender", q.sender)

	req, err := http.NewRequestWithContext(ctx, "GET", q.base+"?"+v.Encode(), nil)
	if err != nil {
		return Quote{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := q.client.Do(req)
	if err != nil {
		return Quote{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return Quote{}, fmt.Errorf("sushi http %d", resp.StatusCode)
	}
	var r struct {
		Status           string `json:"status"`
		AssumedAmountOut string `json:"assumedAmountOut"`
		Tx               struct {
			To    string `json:"to"`
			Data  string `json:"data"`
			Value string `json:"value"`
		} `json:"tx"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return Quote{}, err
	}
	// Sushi answers 200 with a status field when it has no route, so the
	// status is read before the amount: an empty amount would otherwise
	// scale to zero and read as a token that gives you nothing.
	if r.Status != "Success" {
		return Quote{}, fmt.Errorf("no route (%s)", r.Status)
	}
	n, ok := new(big.Int).SetString(r.AssumedAmountOut, 10)
	if !ok {
		return Quote{}, fmt.Errorf("unreadable amount %q", r.AssumedAmountOut)
	}
	return Quote{AmountOut: n, To: r.Tx.To, Data: r.Tx.Data, Value: r.Tx.Value}, nil
}

// Symbol reads symbol() for the label. A token that does not answer gets an
// empty label rather than a guessed one: an invented symbol on a board that
// names contracts is worse than no symbol.
func (q *SushiQuoter) Symbol(ctx context.Context, c *rpcClient, token string) string {
	raw, err := c.call(ctx, "eth_call", []any{
		map[string]string{"to": token, "data": "0x95d89b41"}, "latest"})
	if err != nil {
		return ""
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil {
		return ""
	}
	h := strings.TrimPrefix(hexStr, "0x")
	if len(h) < 128 {
		return ""
	}
	n, ok := new(big.Int).SetString(h[64:128], 16)
	if !ok || n.Int64() == 0 || int(n.Int64())*2+128 > len(h) {
		return ""
	}
	b := make([]byte, 0, n.Int64())
	for i := 0; i < int(n.Int64()); i++ {
		var x big.Int
		x.SetString(h[128+i*2:130+i*2], 16)
		b = append(b, byte(x.Int64()))
	}
	s := strings.TrimSpace(string(b))
	if len(s) > 16 {
		s = s[:16]
	}
	return s
}

// Decimals reads decimals() for the token. Defaults to 18 when the call fails
// or answers nonsense, because 18 is the common case and a refused read must
// not stop the token being examined; the aggregators that care will say so.
func (q *SushiQuoter) Decimals(ctx context.Context, c *rpcClient, token string) int {
	raw, err := c.call(ctx, "eth_call", []any{
		map[string]string{"to": token, "data": "0x313ce567"}, "latest"})
	if err != nil {
		return 18
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil {
		return 18
	}
	n, ok := new(big.Int).SetString(strings.TrimPrefix(hexStr, "0x"), 16)
	if !ok || n.Sign() < 0 || n.Int64() > 36 {
		return 18
	}
	return int(n.Int64())
}
