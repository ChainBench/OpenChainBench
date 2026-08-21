package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// querySQL fetches yesterday's total cross-chain volume per platform from
// Sacha's community datasets (dune.adam_tehc_co.dataset_*).
//
// Dataset schemas:
//   dataset_{platform}_daily  → day, blockchain, volume_usd, fees_usd, txns, wallets
//   dataset_fomo_sol_daily    → day, volume_usd, fees_usd, txns, wallets, wallets_dedup  (no blockchain col)
//   dataset_pumpapp_sol_daily → day, blockchain, volume_usd, fees_usd, txns, wallets, wallets_dedup
//   dataset_pumpfun_relay_daily → day, fill_chain, req_class, volume_usd, app_fees_usd, txns, wallets
//
// pump.fun total = pumpapp Solana + relay swaps (req_class='swap').
// All others: SUM(volume_usd) across all blockchains for latest available day.
const querySQL = `
WITH latest AS (
  SELECT
    'gmgn'     AS platform, SUM(volume_usd) AS volume_usd FROM dune.adam_tehc_co.dataset_gmgn_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_gmgn_daily)
  UNION ALL
  SELECT 'axiom', SUM(volume_usd) FROM dune.adam_tehc_co.dataset_axiom_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_axiom_daily)
  UNION ALL
  SELECT 'trojan', SUM(volume_usd) FROM dune.adam_tehc_co.dataset_trojan_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_trojan_daily)
  UNION ALL
  SELECT 'padre', SUM(volume_usd) FROM dune.adam_tehc_co.dataset_terminal_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_terminal_daily)
  UNION ALL
  SELECT 'photon', SUM(volume_usd) FROM dune.adam_tehc_co.dataset_photon_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_photon_daily)
  UNION ALL
  SELECT 'basedbot', SUM(volume_usd) FROM dune.adam_tehc_co.dataset_basedbot_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_basedbot_daily)
  UNION ALL
  SELECT 'fomo', volume_usd FROM dune.adam_tehc_co.dataset_fomo_sol_daily
    WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_fomo_sol_daily)
  UNION ALL
  SELECT 'pump-fun',
    COALESCE((SELECT SUM(volume_usd) FROM dune.adam_tehc_co.dataset_pumpapp_sol_daily
              WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_pumpapp_sol_daily)), 0)
    + COALESCE((SELECT SUM(volume_usd) FROM dune.adam_tehc_co.dataset_pumpfun_relay_daily
                WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_pumpfun_relay_daily)
                  AND req_class = 'swap'), 0)
)
SELECT platform, volume_usd FROM latest ORDER BY volume_usd DESC
`

const duneBase = "https://api.dune.com/api/v1"

type duneClient struct {
	apiKey string
	http   *http.Client
}

type duneRow struct {
	Platform  string  `json:"platform"`
	VolumeUSD float64 `json:"volume_usd"`
}

func newDuneClient(apiKey string) *duneClient {
	return &duneClient{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 30 * time.Second},
	}
}

func (d *duneClient) req(method, path string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, duneBase+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Dune-Api-Key", d.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return d.http.Do(req)
}

func (d *duneClient) createQuery() (string, error) {
	payload := map[string]any{
		"name":       "OCB: Cross-chain trading platform volume (Sacha datasets)",
		"query_sql":  querySQL,
		"is_private": false,
		"parameters": []any{},
	}
	resp, err := d.req("POST", "/query", payload)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		QueryID int `json:"query_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d", out.QueryID), nil
}

func (d *duneClient) execute(queryID string) (string, error) {
	resp, err := d.req("POST", "/query/"+queryID+"/execute", map[string]any{})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		ExecutionID string `json:"execution_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.ExecutionID, nil
}

func (d *duneClient) executionState(execID string) (string, error) {
	resp, err := d.req("GET", "/execution/"+execID+"/status", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.State, nil
}

func (d *duneClient) latestResult(queryID string) ([]duneRow, error) {
	resp, err := d.req("GET", "/query/"+queryID+"/results", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Result struct {
			Rows []duneRow `json:"rows"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Result.Rows, nil
}
