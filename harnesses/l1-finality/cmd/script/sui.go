package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Sui: latest checkpoint vs a few-back checkpoint. Sui's consensus
// commits checkpoints every ~250 ms; soft finality after 1-2 ckpts.

type suiResp[T any] struct {
	JSONRPC string         `json:"jsonrpc"`
	Result  T              `json:"result"`
	Error   *rpcRespError  `json:"error"`
}

type suiCheckpoint struct {
	SequenceNumber string `json:"sequenceNumber"`
	TimestampMs    string `json:"timestampMs"`
}

func fetchSui(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 8 * time.Second}

	// 1) Latest checkpoint sequence
	var latestSeq suiResp[string]
	if err := suiCall(client, ch.RPCURL, "sui_getLatestCheckpointSequenceNumber", []any{}, &latestSeq); err != nil {
		s.Err = fmt.Sprintf("latest_seq: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	if latestSeq.Error != nil {
		s.Err = fmt.Sprintf("latest_seq_rpc_error: %s", latestSeq.Error.Message)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	latestN, err := strconv.ParseInt(latestSeq.Result, 10, 64)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_seq: %v (raw=%q)", err, latestSeq.Result)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// 2) Latest checkpoint full
	latestCk, err := suiGetCheckpoint(client, ch.RPCURL, latestN)
	if err != nil {
		s.Err = fmt.Sprintf("latest_ckpt: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// 3) Mysticeti finalizes at checkpoint commit. Circle USDC and most
	// production custodians treat 1 checkpoint back as final. Going
	// deeper just inflates the number — depth doesn't add safety on Sui.
	finalN := latestN - 1
	if finalN < 0 {
		finalN = 0
	}
	finalCk, err := suiGetCheckpoint(client, ch.RPCURL, finalN)
	if err != nil {
		s.Err = fmt.Sprintf("final_ckpt: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	latestTs, err := strconv.ParseInt(latestCk.TimestampMs, 10, 64)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_ts: %v", err)
		return s
	}
	finalTs, err := strconv.ParseInt(finalCk.TimestampMs, 10, 64)
	if err != nil {
		s.Err = fmt.Sprintf("parse_final_ts: %v", err)
		return s
	}

	s.LatestBlock = latestN
	s.FinalizedBlock = finalN
	s.BlockLag = latestN - finalN
	s.LagSeconds = float64(latestTs-finalTs) / 1000.0
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func suiGetCheckpoint(client *http.Client, url string, seq int64) (*suiCheckpoint, error) {
	var r suiResp[suiCheckpoint]
	if err := suiCall(client, url, "sui_getCheckpoint", []any{strconv.FormatInt(seq, 10)}, &r); err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc_error: %s", r.Error.Message)
	}
	return &r.Result, nil
}

func suiCall(client *http.Client, url, method string, params []any, out any) error {
	body := rpcReq{JSONRPC: "2.0", ID: 1, Method: method, Params: params}
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
