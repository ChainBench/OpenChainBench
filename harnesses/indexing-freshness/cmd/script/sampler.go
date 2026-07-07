package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The organic sampler. Instead of funding a probe wallet, we pick a
// fresh native transfer from the newest block: real user, real tx,
// different wallet every event — which also makes the ground truth
// impossible for a provider to special-case (there is no benchmark
// wallet to whitelist).
//
// T0 = the instant WE observe the block containing the tx via our own
// RPC. Identical reference for every provider, same host clock.

type rpcTx struct {
	Hash  string `json:"hash"`
	From  string `json:"from"`
	To    string `json:"to"`
	Input string `json:"input"`
	Value string `json:"value"`
}

type rpcBlock struct {
	Number       string  `json:"number"`
	Transactions []rpcTx `json:"transactions"`
}

func rpcCall(method string, params string) (json.RawMessage, error) {
	body := fmt.Sprintf(`{"jsonrpc":"2.0","method":"%s","params":%s,"id":%d}`, method, params, time.Now().UnixNano())
	req, _ := http.NewRequest("POST", rpcHTTP(), strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	if env.Error != nil {
		return nil, fmt.Errorf("rpc: %s", env.Error.Message)
	}
	return env.Result, nil
}

func latestBlock() (*rpcBlock, error) {
	res, err := rpcCall("eth_getBlockByNumber", `["latest",true]`)
	if err != nil {
		return nil, err
	}
	var b rpcBlock
	if err := json.Unmarshal(res, &b); err != nil {
		return nil, err
	}
	return &b, nil
}

// pickNativeTransfer returns a random plain native transfer from the
// block: value > 0, empty calldata, sender is a normal EOA. On OP-stack
// chains transactions[0] is always the L1 system deposit — the
// 0xdeaddead filter drops it.
func pickNativeTransfer(b *rpcBlock) *rpcTx {
	var cands []rpcTx
	for _, tx := range b.Transactions {
		if tx.Input != "0x" || tx.To == "" || strings.EqualFold(tx.From, tx.To) {
			continue
		}
		if strings.HasPrefix(strings.ToLower(tx.From), "0xdeaddead") {
			continue
		}
		v, err := strconv.ParseUint(strings.TrimPrefix(tx.Value, "0x"), 16, 64)
		if err != nil || v == 0 {
			continue
		}
		cands = append(cands, tx)
	}
	if len(cands) == 0 {
		return nil
	}
	tx := cands[rand.Intn(len(cands))]
	return &tx
}

// waitFreshBlock polls the RPC until a block newer than lastSeen with a
// usable native transfer shows up. 500ms cadence bounds the T0 error at
// +500ms, identical for every provider.
func waitFreshBlock(lastSeen uint64) (*rpcBlock, uint64, *rpcTx) {
	for {
		b, err := latestBlock()
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		bn, _ := strconv.ParseUint(strings.TrimPrefix(b.Number, "0x"), 16, 64)
		if bn > lastSeen {
			if tx := pickNativeTransfer(b); tx != nil {
				return b, bn, tx
			}
			lastSeen = bn
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// sanitize strips anything URL-ish from provider errors before logging
// (defense in depth — no endpoint carries a key in this harness's URLs
// except mobula/allium headers, but keep the rule uniform).
func sanitize(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if i := strings.Index(s, "http"); i >= 0 {
		return s[:i] + "<url>"
	}
	return s
}

var _ = bytes.MinRead
