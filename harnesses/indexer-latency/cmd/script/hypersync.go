package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Envio HyperSync poller.
//
// Probed entity: the exact USDC Transfer log (matched by tx hash) via
// POST /query scoped to [bn, bn+1). While HyperSync's archive height is
// below bn the query legitimately returns no logs (next_block <= bn),
// so substring detection on the tx hash is a correct "queryable yet?"
// signal. /query requires a free bearer token since Nov 2025
// (HYPERSYNC_TOKEN); without it the provider runs disabled.

const hypersyncBase = "https://eth.hypersync.xyz"

func checkHyperSync(ev probeEvent) (bool, error) {
	bn, txHash := ev.Block, ev.TxHash
	apiCalls.WithLabelValues("hypersync").Inc()
	body := fmt.Sprintf(
		`{"from_block":%d,"to_block":%d,"logs":[{"address":["%s"],"topics":[["%s"]]}],"field_selection":{"log":["transaction_hash","block_number","log_index"]}}`,
		bn, bn+1, usdcContract, transferTopic,
	)
	req, err := http.NewRequest("POST", hypersyncBase+"/query", strings.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+hypersyncToken())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	return bodyContains(resp, txHash)
}

// hypersyncHeight hits the keyless /height endpoint. Used at startup as
// a reachability proof (and logged) even when HYPERSYNC_TOKEN is unset.
func hypersyncHeight() (uint64, error) {
	req, err := http.NewRequest("GET", hypersyncBase+"/height", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, err
	}
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	var out struct {
		Height uint64 `json:"height"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return 0, err
	}
	return out.Height, nil
}
