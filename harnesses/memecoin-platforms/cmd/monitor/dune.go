package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// feesSQL is the Dune Trino SQL embedded here for auto-create.
// Mirrors harnesses/memecoin-platforms/queries/platform_fees.sql.
const feesSQL = `
WITH

token_fees AS (
  SELECT
    CASE
      WHEN token_balance_owner IN (
        'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT','7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA',
        'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3','ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy',
        'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9','3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK',
        'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx','dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ',
        '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn'
      ) THEN 'gmgn'
      WHEN token_balance_owner IN (
        '7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj','4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S',
        'CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ','AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW',
        '7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws','9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP',
        'DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy','4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd',
        '76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf','H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK',
        '8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm','4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz',
        '8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb','86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG',
        'DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM','5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB',
        'DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF','Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9',
        '846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8','5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg'
      ) THEN 'axiom'
      WHEN token_balance_owner IN ('HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq') THEN 'fomo'
      WHEN token_balance_owner IN (
        '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco','92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH',
        '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ','65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH',
        'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp','8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn'
      ) THEN 'trojan'
      WHEN token_balance_owner IN ('AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH') THEN 'photon'
      WHEN token_balance_owner IN (
        'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36','FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN'
      ) THEN 'maestro'
    END AS platform,
    token_mint_address,
    GREATEST(post_token_balance - pre_token_balance, 0) AS inflow
  FROM solana.account_activity
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND token_mint_address IN (
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'So11111111111111111111111111111111111111112'
    )
    AND post_token_balance > pre_token_balance
    AND token_balance_owner IN (
      'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT','7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA',
      'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3','ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy',
      'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9','3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK',
      'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx','dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ',
      '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn',
      '7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj','4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S',
      'CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ','AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW',
      '7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws','9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP',
      'DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy','4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd',
      '76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf','H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK',
      '8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm','4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz',
      '8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb','86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG',
      'DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM','5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB',
      'DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF','Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9',
      '846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8','5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg',
      'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq',
      '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco','92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH',
      '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ','65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH',
      'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp','8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn',
      'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH',
      'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36','FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN'
    )
),

token_agg AS (
  SELECT
    platform,
    SUM(CASE WHEN token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN inflow ELSE 0 END) / 1e6 AS usdc_fees_24h,
    SUM(CASE WHEN token_mint_address = 'So11111111111111111111111111111111111111112' THEN inflow ELSE 0 END) / 1e9 AS wsol_fees_24h,
    0.0 AS sol_fees_24h
  FROM token_fees
  WHERE platform IS NOT NULL
  GROUP BY platform
),

pumpfun_trade_fees AS (
  SELECT
    'pump-fun' AS platform,
    0.0 AS usdc_fees_24h,
    0.0 AS wsol_fees_24h,
    SUM(sol_amount * 0.01) AS sol_fees_24h
  FROM pump_fun_solana.trades
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND tx_type = 'buy'
),

pumpfun_wallet_fees AS (
  SELECT
    'pump-fun' AS platform,
    0.0 AS usdc_fees_24h,
    0.0 AS wsol_fees_24h,
    SUM(CAST(post_balance - pre_balance AS DOUBLE)) / 1e9 AS sol_fees_24h
  FROM solana.account_activity
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND address IN (
      'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM','62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
      'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz','7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
      'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY','9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
      'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP','7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
      'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS'
    )
    AND post_balance > pre_balance
    AND token_mint_address IS NULL
)

SELECT platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h FROM token_agg
UNION ALL
SELECT platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h FROM pumpfun_trade_fees
UNION ALL
SELECT platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h FROM pumpfun_wallet_fees
ORDER BY platform
`

const duneBase = "https://api.dune.com/api/v1"

type duneClient struct {
	apiKey string
	http   *http.Client
}

type duneRow struct {
	Platform    string  `json:"platform"`
	USDCFees24h float64 `json:"usdc_fees_24h"`
	WSOLFees24h float64 `json:"wsol_fees_24h"`
	SOLFees24h  float64 `json:"sol_fees_24h"`
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
		"name":       "OCB: Memecoin Platform Fees 24h",
		"query_sql":  feesSQL,
		"is_private": false,
		"parameters": []any{},
	}
	resp, err := d.req("POST", "/query", payload)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
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
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
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
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
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
