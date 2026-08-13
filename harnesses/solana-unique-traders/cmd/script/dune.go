package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// querySQL counts unique fee-paying transactions per Solana trading platform.
// Uses the same inflow-only filter as bench 203: only rows where the fee wallet
// actually received SOL (post_balance > pre_balance) or USDC/WSOL tokens
// (post_token_balance > pre_token_balance via token_balance_owner).
// This avoids counting transactions where fee wallet addresses appear as
// program IDs or read-only accounts without any balance change.
const querySQL = `
WITH fee_wallets AS (
  SELECT address, platform FROM (VALUES
    ('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM','pump-fun'),
    ('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV','pump-fun'),
    ('FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz','pump-fun'),
    ('7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX','pump-fun'),
    ('AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY','pump-fun'),
    ('9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz','pump-fun'),
    ('G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP','pump-fun'),
    ('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ','pump-fun'),
    ('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS','pump-fun'),
    ('BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT','gmgn'),
    ('7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA','gmgn'),
    ('HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3','gmgn'),
    ('ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy','gmgn'),
    ('DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9','gmgn'),
    ('3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK','gmgn'),
    ('DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx','gmgn'),
    ('dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ','gmgn'),
    ('6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn','gmgn'),
    ('7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj','axiom'),
    ('4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S','axiom'),
    ('CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ','axiom'),
    ('AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW','axiom'),
    ('7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws','axiom'),
    ('9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP','axiom'),
    ('DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy','axiom'),
    ('4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd','axiom'),
    ('76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf','axiom'),
    ('H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK','axiom'),
    ('8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm','axiom'),
    ('4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz','axiom'),
    ('8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb','axiom'),
    ('86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG','axiom'),
    ('DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM','axiom'),
    ('5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB','axiom'),
    ('DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF','axiom'),
    ('Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9','axiom'),
    ('846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8','axiom'),
    ('5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg','axiom'),
    ('HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq','fomo'),
    ('9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco','trojan'),
    ('92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH','trojan'),
    ('2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ','trojan'),
    ('65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH','trojan'),
    ('BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp','trojan'),
    ('8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn','trojan'),
    ('AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH','photon'),
    ('MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36','maestro'),
    ('FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN','maestro')
  ) AS t(address, platform)
),
fee_activity AS (
  SELECT fw.platform, a.tx_id
  FROM solana.account_activity a
  JOIN fee_wallets fw ON a.address = fw.address
  WHERE a.block_time >= NOW() - INTERVAL '1' DAY
    AND a.token_mint_address IS NULL
    AND a.post_balance > a.pre_balance
  UNION
  SELECT fw.platform, a.tx_id
  FROM solana.account_activity a
  JOIN fee_wallets fw ON a.token_balance_owner = fw.address
  WHERE a.block_time >= NOW() - INTERVAL '1' DAY
    AND a.token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    AND a.post_token_balance > a.pre_token_balance
  UNION
  SELECT fw.platform, a.tx_id
  FROM solana.account_activity a
  JOIN fee_wallets fw ON a.token_balance_owner = fw.address
  WHERE a.block_time >= NOW() - INTERVAL '1' DAY
    AND a.token_mint_address = 'So11111111111111111111111111111111111111112'
    AND a.post_token_balance > a.pre_token_balance
)
SELECT platform, COUNT(DISTINCT tx_id) AS unique_traders_24h
FROM fee_activity
GROUP BY platform
ORDER BY unique_traders_24h DESC
`

const duneBase = "https://api.dune.com/api/v1"

type duneClient struct {
	apiKey string
	http   *http.Client
}

type duneRow struct {
	Platform         string  `json:"platform"`
	UniqueTraders24h float64 `json:"unique_traders_24h"`
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
		"name":       "OCB: Solana Unique Traders 24h by Platform",
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
