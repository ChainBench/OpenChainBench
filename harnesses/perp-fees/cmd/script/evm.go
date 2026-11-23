package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
)

type rpcCall struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcError struct {
	Message string `json:"message"`
}

type rpcResp struct {
	ID     *int      `json:"id"`
	Result string    `json:"result"`
	Error  *rpcError `json:"error"`
}

type ethCallMsg struct {
	To   string
	Data string
}

type ethCallOutcome struct {
	Result string
	Err    error
}

func newEthCall(id int, m ethCallMsg) rpcCall {
	return rpcCall{
		JSONRPC: "2.0", ID: id, Method: "eth_call",
		Params: []any{map[string]string{"to": m.To, "data": m.Data}, "latest"},
	}
}

func postJSON(client *http.Client, endpoint string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("invalid endpoint url")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, withoutURL(err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status_%d: %s",
			resp.StatusCode, truncate(string(respBody), 120))
	}
	return respBody, nil
}

func withoutURL(err error) error {
	var ue *url.Error
	if !errors.As(err, &ue) {
		return err
	}
	host := "endpoint"
	if u, perr := url.Parse(ue.URL); perr == nil {
		host = u.Host
	}
	return fmt.Errorf("%s %s: %w", ue.Op, host, ue.Err)
}

func ethCall(client *http.Client, rpcURL, to, data string) (string, error) {
	respBody, err := postJSON(client, rpcURL, newEthCall(1, ethCallMsg{To: to, Data: data}))
	if err != nil {
		return "", err
	}
	var r rpcResp
	if err := json.Unmarshal(respBody, &r); err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return "", fmt.Errorf("rpc: %s", r.Error.Message)
	}
	if len(r.Result) <= len("0x") {
		return "", errors.New("rpc: empty result")
	}
	return r.Result, nil
}

func ethCallBatch(
	client *http.Client,
	rpcURL string,
	msgs []ethCallMsg,
) ([]ethCallOutcome, error) {
	calls := make([]rpcCall, len(msgs))
	for i, m := range msgs {
		calls[i] = newEthCall(i, m)
	}
	respBody, err := postJSON(client, rpcURL, calls)
	if err != nil {
		return nil, err
	}
	var resps []rpcResp
	if err := json.Unmarshal(respBody, &resps); err != nil {
		var single rpcResp
		if json.Unmarshal(respBody, &single) == nil && single.Error != nil {
			return nil, fmt.Errorf("rpc: %s", single.Error.Message)
		}
		return nil, fmt.Errorf("parse: %w", err)
	}
	out := make([]ethCallOutcome, len(msgs))
	for i := range out {
		out[i].Err = errors.New("rpc: no response")
	}
	seen := make([]bool, len(msgs))
	for _, r := range resps {
		if r.ID == nil || *r.ID < 0 || *r.ID >= len(msgs) || seen[*r.ID] {
			return nil, errors.New("rpc: batch reply with a missing, unknown or repeated id")
		}
		id := *r.ID
		seen[id] = true
		switch {
		case r.Error != nil:
			out[id] = ethCallOutcome{Err: fmt.Errorf("rpc: %s", r.Error.Message)}
		case len(r.Result) <= len("0x"):
			out[id] = ethCallOutcome{Err: errors.New("rpc: empty result")}
		default:
			out[id] = ethCallOutcome{Result: r.Result}
		}
	}
	return out, nil
}

const abiWordHexLen = 64

func uint256ArgAt(result string, slotIdx int) *big.Int {
	hexStr := strings.TrimPrefix(result, "0x")
	start := slotIdx * 64
	if start+64 > len(hexStr) {
		return big.NewInt(0)
	}
	n := new(big.Int)
	n.SetString(hexStr[start:start+64], 16)
	return n
}

var twoPow255 = new(big.Int).Lsh(big.NewInt(1), 255)
var twoPow256 = new(big.Int).Lsh(big.NewInt(1), 256)

func int256ArgAt(result string, slotIdx int) *big.Int {
	n := uint256ArgAt(result, slotIdx)
	if n.Cmp(twoPow255) >= 0 {
		n.Sub(n, twoPow256)
	}
	return n
}

func abiUint(n *big.Int) string {
	return fmt.Sprintf("%064x", n)
}

func abiUint64(n uint64) string {
	return fmt.Sprintf("%064x", n)
}

func abiBool(b bool) string {
	if b {
		return abiUint64(1)
	}
	return abiUint64(0)
}

func abiAddress(addr string) string {
	return fmt.Sprintf("%064s", strings.ToLower(strings.TrimPrefix(addr, "0x")))
}

func usdScaled(usd float64, decimals int) *big.Int {
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	f := new(big.Float).SetPrec(256).SetFloat64(usd)
	n, _ := f.Mul(f, new(big.Float).SetInt(scale)).Int(nil)
	return n
}

func ratioFloat(num, den *big.Int) float64 {
	f, _ := new(big.Float).Quo(new(big.Float).SetInt(num), new(big.Float).SetInt(den)).Float64()
	return f
}
