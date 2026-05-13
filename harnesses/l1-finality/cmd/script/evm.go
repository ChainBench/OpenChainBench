package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResp struct {
	Result *evmBlock      `json:"result"`
	Error  *rpcRespError  `json:"error"`
}

type rpcRespError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Minimal block fields we need.
type evmBlock struct {
	Number    string `json:"number"`    // hex
	Timestamp string `json:"timestamp"` // hex (unix seconds)
}

func fetchEVM(ch ChainConfig) FinalitySample {
	s := FinalitySample{Chain: ch.Slug, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()

	client := &http.Client{Timeout: 8 * time.Second}

	latest, err := evmGetBlock(client, ch.RPCURL, "latest")
	if err != nil {
		s.Err = fmt.Sprintf("latest: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	final, err := evmGetBlock(client, ch.RPCURL, "finalized")
	if err != nil {
		s.Err = fmt.Sprintf("finalized: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}
	s.FetchLatencyMs = time.Since(start).Milliseconds()

	latestNum, err := hexToInt64(latest.Number)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_number: %v", err)
		return s
	}
	finalNum, err := hexToInt64(final.Number)
	if err != nil {
		s.Err = fmt.Sprintf("parse_finalized_number: %v", err)
		return s
	}
	latestTs, err := hexToInt64(latest.Timestamp)
	if err != nil {
		s.Err = fmt.Sprintf("parse_latest_ts: %v", err)
		return s
	}
	finalTs, err := hexToInt64(final.Timestamp)
	if err != nil {
		s.Err = fmt.Sprintf("parse_finalized_ts: %v", err)
		return s
	}

	s.LatestBlock = latestNum
	s.FinalizedBlock = finalNum
	s.BlockLag = latestNum - finalNum
	s.LagSeconds = float64(latestTs - finalTs)
	if s.LagSeconds < 0 {
		s.LagSeconds = 0
	}
	return s
}

func evmGetBlock(client *http.Client, url, tag string) (*evmBlock, error) {
	body := rpcReq{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "eth_getBlockByNumber",
		Params:  []any{tag, false},
	}
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	var parsed rpcResp
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("parse: %v body=%s", err, truncate(string(respBody), 200))
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("rpc_error %d: %s", parsed.Error.Code, parsed.Error.Message)
	}
	if parsed.Result == nil {
		return nil, fmt.Errorf("empty_result")
	}
	return parsed.Result, nil
}

func hexToInt64(s string) (int64, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if s == "" {
		return 0, fmt.Errorf("empty hex")
	}
	return strconv.ParseInt(s, 16, 64)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
