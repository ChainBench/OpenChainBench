package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// Solana slot push via `slotSubscribe`. The notification frame looks
// like:
//
//	{"jsonrpc":"2.0","method":"slotNotification",
//	 "params":{"result":{"parent":364,"root":362,"slot":365},"subscription":0}}
//
// The slot number is the cohort key, playing the role the block number
// plays on EVM chains. Solana slots tick every ~400ms, so the cohort
// churn is higher but the settle/score path is identical.

type solanaEnvelope struct {
	Method string `json:"method"`
	Params *struct {
		Result struct {
			Slot int64 `json:"slot"`
		} `json:"result"`
	} `json:"params,omitempty"`
	// Subscribe ack: {"jsonrpc":"2.0","result":23784,"id":1}
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func runSolanaConn(ep Endpoint) error {
	conn, bumpHead, cleanup, err := dialAndGuard(ep)
	if err != nil {
		return err
	}
	defer cleanup()

	if err := conn.WriteJSON(rpcReq{
		JSONRPC: "2.0", ID: 1, Method: "slotSubscribe",
		Params: []any{},
	}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	wsHealth.WithLabelValues(ep.Provider, ep.Chain).Set(1)
	fmt.Printf("[%s/%s] connected, subscribed to slotSubscribe\n", ep.Provider, ep.Chain)

	agg := aggregatorFor(ep.Chain)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var env solanaEnvelope
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}
		if env.Error != nil {
			// Endpoint answered the subscribe with a JSON-RPC error
			// (method disabled, quota, ...). Surface it and let the
			// outer loop back off instead of holding a dead socket.
			return fmt.Errorf("subscribe error %d: %s", env.Error.Code, env.Error.Message)
		}
		if env.Method != "slotNotification" || env.Params == nil {
			continue // subscribe ack or unrelated frame
		}
		slot := env.Params.Result.Slot
		if slot == 0 {
			continue
		}
		now := time.Now()
		bumpHead()
		wsHealth.WithLabelValues(ep.Provider, ep.Chain).Set(1)
		agg.record(ep.Provider, slot, now)
	}
}
