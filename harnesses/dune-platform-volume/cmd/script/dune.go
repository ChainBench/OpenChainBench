package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// querySQL fetches the latest complete day's cross-chain metrics per platform
// from Dune community datasets.
//
// Returns per platform: volume_usd, txns, fees_usd, avg_trade_usd, fee_rate_pct.
// pump.fun = pumpapp Solana + relay swaps (req_class='swap'), fees=0 (fee cut Aug 2026).
// fomo = Solana only (dataset_fomo_sol_daily, no blockchain col).
// All others sum across all blockchains for latest available day.
const querySQL = `
WITH latest AS (
  SELECT 'gmgn' AS platform, SUM(volume_usd) AS volume_usd, SUM(CAST(txns AS BIGINT)) AS txns, SUM(CAST(fees_usd AS DOUBLE)) AS fees_usd
    FROM dune.adam_tehc_co.dataset_gmgn_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_gmgn_daily)
  UNION ALL
  SELECT 'axiom', SUM(volume_usd), SUM(CAST(txns AS BIGINT)), SUM(CAST(fees_usd AS DOUBLE))
    FROM dune.adam_tehc_co.dataset_axiom_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_axiom_daily)
  UNION ALL
  SELECT 'trojan', SUM(volume_usd), SUM(CAST(txns AS BIGINT)), SUM(CAST(fees_usd AS DOUBLE))
    FROM dune.adam_tehc_co.dataset_trojan_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_trojan_daily)
  UNION ALL
  SELECT 'padre', SUM(volume_usd), SUM(CAST(txns AS BIGINT)), SUM(CAST(fees_usd AS DOUBLE))
    FROM dune.adam_tehc_co.dataset_terminal_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_terminal_daily)
  UNION ALL
  SELECT 'photon', SUM(volume_usd), SUM(CAST(txns AS BIGINT)), SUM(CAST(fees_usd AS DOUBLE))
    FROM dune.adam_tehc_co.dataset_photon_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_photon_daily)
  UNION ALL
  SELECT 'basedbot', SUM(volume_usd), SUM(CAST(txns AS BIGINT)), SUM(CAST(fees_usd AS DOUBLE))
    FROM dune.adam_tehc_co.dataset_basedbot_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_basedbot_daily)
  UNION ALL
  SELECT 'fomo', volume_usd, CAST(txns AS BIGINT), CAST(fees_usd AS DOUBLE)
    FROM dune.adam_tehc_co.dataset_fomo_sol_daily WHERE day = (SELECT MAX(day) FROM dune.adam_tehc_co.dataset_fomo_sol_daily)
  UNION ALL
  SELECT 'pump-fun',
    COALESCE((SELECT SUM(volume_usd) FROM dune.adam_tehc_co.dataset_pumpapp_sol_daily WHERE day=(SELECT MAX(day) FROM dune.adam_tehc_co.dataset_pumpapp_sol_daily)),0)
    + COALESCE((SELECT SUM(volume_usd) FROM dune.adam_tehc_co.dataset_pumpfun_relay_daily WHERE day=(SELECT MAX(day) FROM dune.adam_tehc_co.dataset_pumpfun_relay_daily) AND req_class='swap'),0),
    COALESCE((SELECT SUM(CAST(txns AS BIGINT)) FROM dune.adam_tehc_co.dataset_pumpapp_sol_daily WHERE day=(SELECT MAX(day) FROM dune.adam_tehc_co.dataset_pumpapp_sol_daily)),0)
    + COALESCE((SELECT SUM(CAST(txns AS BIGINT)) FROM dune.adam_tehc_co.dataset_pumpfun_relay_daily WHERE day=(SELECT MAX(day) FROM dune.adam_tehc_co.dataset_pumpfun_relay_daily) AND req_class='swap'),0),
    CAST(0 AS DOUBLE)
)
SELECT platform, volume_usd, txns, fees_usd,
  CASE WHEN txns > 0 THEN volume_usd / txns ELSE NULL END AS avg_trade_usd,
  CASE WHEN volume_usd > 0 THEN fees_usd / volume_usd * 100 ELSE 0.0 END AS fee_rate_pct
FROM latest ORDER BY volume_usd DESC
`

const duneBase = "https://api.dune.com/api/v1"

type duneClient struct {
	apiKey string
	http   *http.Client
}

type duneRow struct {
	Platform   string  `json:"platform"`
	VolumeUSD  float64 `json:"volume_usd"`
	Txns       float64 `json:"txns"`
	FeesUSD    float64 `json:"fees_usd"`
	AvgTradeUSD float64 `json:"avg_trade_usd"`
	FeeRatePct float64 `json:"fee_rate_pct"`
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
		"name":       "OCB: Cross-chain trading platform metrics",
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
