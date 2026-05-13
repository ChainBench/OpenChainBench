package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Solana doesn't expose a finalized block timestamp via a single call.
// Strategy:
//   - getSlot(commitment=processed) → latest slot
//   - getSlot(commitment=finalized) → finalized slot
//   - getBlockTime(latest) and getBlockTime(finalized) → unix seconds
// Block time gaps and skipped slots are normal — we use the timestamp
// difference, not slot×400ms, to stay grounded in real wall-clock.

type solanaResp[T any] struct {
	Result *T            `json:"result"`
	Error  *rpcRespError `json:"error"`
}

func fetchSolana(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()

	client := &http.Client{Timeout: 8 * time.Second}

	processedSlot, err := solanaGetSlot(client, ch.RPCURL, "processed")
	if err != nil {
		s.Err = fmt.Sprintf("processed_slot: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	finalizedSlot, err := solanaGetSlot(client, ch.RPCURL, "finalized")
	if err != nil {
		s.Err = fmt.Sprintf("finalized_slot: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	processedTs, err := solanaGetBlockTime(client, ch.RPCURL, processedSlot)
	if err != nil {
		// Block time is sometimes unavailable for very fresh slots — try
		// stepping back a few slots until we find one.
		for delta := int64(1); delta < 10 && err != nil; delta++ {
			processedTs, err = solanaGetBlockTime(client, ch.RPCURL, processedSlot-delta)
		}
		if err != nil {
			s.Err = fmt.Sprintf("processed_blocktime: %v", err)
			s.FetchLatencyMs = time.Since(start).Milliseconds()
			return s
		}
	}
	finalizedTs, err := solanaGetBlockTime(client, ch.RPCURL, finalizedSlot)
	if err != nil {
		s.Err = fmt.Sprintf("finalized_blocktime: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	s.LatestBlock = processedSlot
	s.FinalizedBlock = finalizedSlot
	s.BlockLag = processedSlot - finalizedSlot
	s.LagSeconds = float64(processedTs - finalizedTs)
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func solanaGetSlot(client *http.Client, url, commitment string) (int64, error) {
	body := rpcReq{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getSlot",
		Params:  []any{map[string]string{"commitment": commitment}},
	}
	var parsed solanaResp[int64]
	if err := solanaCall(client, url, body, &parsed); err != nil {
		return 0, err
	}
	if parsed.Result == nil {
		return 0, fmt.Errorf("empty_slot_result")
	}
	return *parsed.Result, nil
}

func solanaGetBlockTime(client *http.Client, url string, slot int64) (int64, error) {
	body := rpcReq{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getBlockTime",
		Params:  []any{slot},
	}
	var parsed solanaResp[int64]
	if err := solanaCall(client, url, body, &parsed); err != nil {
		return 0, err
	}
	if parsed.Result == nil {
		return 0, fmt.Errorf("no_block_time")
	}
	return *parsed.Result, nil
}

func solanaCall(client *http.Client, url string, body rpcReq, out any) error {
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("parse: %v", err)
	}
	return nil
}
