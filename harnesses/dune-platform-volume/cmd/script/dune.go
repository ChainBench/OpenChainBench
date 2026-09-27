package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// publishedPlatforms is every platform this harness has a series for. A platform
// missing from a query result has its gauges dropped rather than left on the
// figures from the last poll that carried it, so the list has to stay in step
// with the query. basedbot and pump-fun are listed and deliberately not
// produced by querySQL, so their series are deleted on every poll:
//
//   - basedbot: no fee wallet or router list for it exists in the DeFiLlama
//     adapter repo or anywhere else public, and it has no DeFiLlama listing to
//     check a guess against. Nothing to attribute it from.
//   - pump-fun: it charges no bonding-curve fee since 2026-08-07, so fee-wallet
//     attribution cannot see it. The transactions invoking its app program
//     (6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB, the account DeFiLlama's
//     dexs/pumpfun-app.ts keys on) read 33% above the retired pumpapp dataset
//     for 2026-08-25 and 69% above DeFiLlama's own figure for 2026-09-25, so it
//     is a different measurement from the series this row used to carry rather
//     than a replacement for it.
var publishedPlatforms = []string{
	"gmgn", "axiom", "trojan", "padre", "photon", "basedbot", "fomo", "pump-fun",
}

// dayParam is the Dune query parameter holding the UTC day to measure, as
// YYYY-MM-DD. The day has to reach the query as a literal: Dune substitutes the
// macro textually before planning, so CAST('2026-09-26' AS date) folds to a
// constant and Trino prunes to that one block_date partition. Computing the day
// inside SQL from a scalar subquery over dex_solana.trades instead cost 583
// credits against 25 for the pinned form, because the filter is then unknown at
// planning time and every partition is read. Measured 2026-09-27; do not put the
// day back inside the query.
const dayParam = "data_day"

// querySQL measures one complete UTC day of Solana trading volume, transactions,
// platform fees and unique wallets per trading platform, from Dune's own tables.
//
// Source tiers, learned the hard way on 2026-09-27. Raw solana.* and Spellbook
// dex_solana.* / prices.* are maintained by Dune and do not rot. A
// dune.<user>.<dataset> table is one person's upload and can freeze silently:
// this harness read eight of them, they all stopped on 2026-08-25, the query
// took MAX(day) so nothing errored, and four benches published a month-old day
// as live for 32 days. Never depend on the third kind again.
//
// Method, the one DeFiLlama's own Solana adapters use, so the figures are
// checkable against a public number for the same day:
//
//  1. Find the transactions in which a platform's fee wallet received value, in
//     solana.account_activity. Keying on the fee collector rather than on a
//     router survives a platform rotating routers, which they do.
//  2. Join those transactions to dex_solana.trades and take one leg per
//     (transaction, trader) so a multi-hop route is not counted several times.
//     The SOL leg is the trade's notional, so it wins the tie-break; otherwise
//     the largest leg does. Dropping this dedup overstates volume by 8% to 18%
//     across this cohort.
//  3. Fees are what the wallets received that day on those same transactions:
//     lamports on the fee wallet itself, plus USDC and wSOL landing in token
//     accounts it owns, priced with the day's SOL close from prices.day. Summing
//     every inflow instead would count a sweep between two of a platform's own fee
//     wallets, and would put a figure in the take rate's numerator that its
//     denominator has no volume for: on 2026-09-25 that read padre 37% and fomo 26%
//     higher than the transactions behind the volume support.
//
// Measured against DeFiLlama for 2026-09-25, Solana leg only: axiom +0.1%,
// trojan +0.0%, gmgn -2.2%, padre -2.6%, photon +11.8%. Photon is the one
// outlier and the reason is known: DeFiLlama's dexs/photon.ts counts only the
// SOL fee branch, while this query also counts Photon transactions whose fee was
// paid in USDC or wSOL. fomo lands within 3.4% of the retired dataset for
// 2026-08-25. Every platform reads above its own frozen 2026-08-25 row by 14% to
// 54% because dex_solana.trades keeps decoding more venues, so a historical
// re-run finds trades the adapter could not see when it first ran; the same-day
// comparison against DeFiLlama is the meaningful one.
//
// Scope: Solana only. GMGN, Axiom and padre also trade on EVM chains, and those
// legs are not in here; the specs say so. Cost: 25 credits per execution measured
// 2026-09-27, one execution a day. Restricting the fees to the volume transactions
// and reading the day's last trade cost 18 of those 25; without them the query is 7,
// which is not worth a take rate whose halves describe different transactions.
const querySQL = `
-- Fee wallets, per platform. gmgn, axiom, trojan and photon are the lists
-- carried by the DeFiLlama adapter repo (dexs/gmgnai.ts, dexs/axiom.ts,
-- dexs/trojan/index.ts, dexs/photon.ts) and by our own solana-unique-traders
-- harness, which agree address for address; read 2026-09-27. padre is pump.fun's
-- trading app, formerly Padre: the two wallets are from
-- dexs/trading-terminal/index.ts, the adapter behind DeFiLlama's "Terminal"
-- listing, and they reproduce that listing to within 2.6% for 2026-09-25. fomo
-- takes its cut in USDC to this owner wallet, so it is matched through
-- token_balance_owner rather than through address.
WITH fee_wallets AS (
  SELECT address, platform FROM (VALUES
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
    ('9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco','trojan'),
    ('92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH','trojan'),
    ('2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ','trojan'),
    ('65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH','trojan'),
    ('BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp','trojan'),
    ('8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn','trojan'),
    ('AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH','photon'),
    ('J5XGHmzrRmnYWbmw45DbYkdZAU2bwERFZ11qCDXPvFB5','padre'),
    ('DoAsxPQgiyAxyaJNvpAAUb2ups6rbJRdYrCPyWxwRxBb','padre'),
    ('R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX','fomo')
  ) AS t(address, platform)
),
-- address_prefix is the partition key on solana.account_activity, so handing it
-- the two leading characters of every fee wallet prunes the day's partitions
-- instead of reading all of them. It cannot help the token_balance_owner branch,
-- whose prefix belongs to the token account rather than to the owner.
wallet_prefixes AS (SELECT DISTINCT substr(address, 1, 2) AS pfx FROM fee_wallets),
sol_price AS (
  SELECT MAX(p.price) AS price
  FROM prices.day p
  WHERE p.blockchain = 'solana'
    AND p.contract_address_varchar = 'So11111111111111111111111111111111111111112'
    AND CAST(p.timestamp AS date) = CAST('{{data_day}}' AS date)
),
sol_fee_legs AS (
  SELECT fw.platform, a.tx_id, CAST(a.balance_change AS double) / 1e9 AS sol_amount
  FROM solana.account_activity a
  JOIN fee_wallets fw ON a.address = fw.address
  WHERE a.block_date = CAST('{{data_day}}' AS date)
    AND a.address_prefix IN (SELECT pfx FROM wallet_prefixes)
    AND a.tx_success
    AND a.token_mint_address IS NULL
    AND a.balance_change > 0
),
-- pre_token_balance and post_token_balance are decimal-adjusted token amounts,
-- not raw base units: fomo's fees here came to 368,584.19 against the retired
-- dataset's 368,582.66 for 2026-08-25, and its fee is entirely USDC through this
-- branch, so a raw-unit reading would have been off by a factor of a million.
spl_fee_legs AS (
  SELECT fw.platform, a.tx_id, a.token_mint_address,
         CAST(a.post_token_balance - a.pre_token_balance AS double) AS token_amount
  FROM solana.account_activity a
  JOIN fee_wallets fw ON a.token_balance_owner = fw.address
  WHERE a.block_date = CAST('{{data_day}}' AS date)
    AND a.tx_success
    AND a.token_mint_address IN (
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'So11111111111111111111111111111111111111112'
    )
    AND a.post_token_balance > a.pre_token_balance
),
fee_txs AS (
  SELECT platform, tx_id FROM sol_fee_legs
  UNION
  SELECT platform, tx_id FROM spl_fee_legs
),
legs AS (
  SELECT f.platform, tr.tx_id, tr.trader_id, tr.amount_usd, tr.block_time,
         (tr.token_bought_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
          OR tr.token_sold_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') AS has_usdc,
         ROW_NUMBER() OVER (
           PARTITION BY f.platform, tr.tx_id, tr.trader_id
           ORDER BY CASE WHEN tr.token_bought_mint_address = 'So11111111111111111111111111111111111111112'
                           OR tr.token_sold_mint_address = 'So11111111111111111111111111111111111111112'
                         THEN 0 ELSE 1 END,
                    tr.amount_usd DESC
         ) AS rn_trade
  FROM dex_solana.trades tr
  JOIN fee_txs f ON f.tx_id = tr.tx_id
  WHERE tr.block_date = CAST('{{data_day}}' AS date)
    AND tr.trader_id NOT IN (SELECT address FROM fee_wallets)
),
-- fomo sponsors the gas on every trade it routes, so one transaction carries
-- several trader ids and the per-(transaction, trader) rule counts one trade as
-- many. Its own leg is the USDC one, because it charges a flat USDC fee: one
-- USDC leg per transaction, which is what DeFiLlama's dexs/fomo does and what
-- lands within 3.4% of the retired series for 2026-08-25. The trader ids on
-- those legs are fomo's own routing accounts rather than its users, so the
-- wallet count is left NULL and the harness drops that gauge instead of
-- publishing a number that would read two orders of magnitude too low.
fomo_legs AS (
  SELECT tx_id, amount_usd,
         ROW_NUMBER() OVER (PARTITION BY tx_id ORDER BY amount_usd DESC) AS rn
  FROM legs
  WHERE platform = 'fomo' AND has_usdc
),
-- The transactions that produced volume, per platform. Fees are summed over this
-- set rather than over every inflow to the wallets, so the take rate's numerator
-- and denominator describe the same transactions: an inflow with no trade behind
-- it, a sweep between two of a platform's own fee wallets or a token account
-- closing back into its owner, is not a fee and does not belong in either.
volume_txs AS (
  SELECT DISTINCT platform, tx_id FROM legs WHERE platform <> 'fomo'
  UNION
  SELECT 'fomo', tx_id FROM fomo_legs
),
platform_fees AS (
  SELECT f.platform, SUM(f.usd) AS fees_usd
  FROM (
    SELECT s.platform, s.tx_id, s.sol_amount * (SELECT price FROM sol_price) AS usd
    FROM sol_fee_legs s
    UNION ALL
    SELECT p.platform, p.tx_id,
           CASE WHEN p.token_mint_address = 'So11111111111111111111111111111111111111112'
                THEN p.token_amount * (SELECT price FROM sol_price)
                ELSE p.token_amount END AS usd
    FROM spl_fee_legs p
  ) f
  JOIN volume_txs v ON v.platform = f.platform AND v.tx_id = f.tx_id
  GROUP BY 1
),
-- The last trade of the day the query actually saw. A day that is only partly
-- loaded returns a fraction of its volume and would otherwise be published as a
-- whole day, which the data day alone cannot catch because the harness chose it.
-- Taken across the whole cohort, not per platform, so a genuinely quiet platform
-- is not mistaken for a truncated load.
day_last_trade AS (SELECT to_unixtime(MAX(block_time)) AS last_trade_unix FROM legs),
per_platform AS (
  SELECT platform,
         SUM(CASE WHEN rn_trade = 1 THEN amount_usd END) AS volume_usd,
         COUNT(DISTINCT tx_id) AS txns,
         COUNT(DISTINCT trader_id) AS wallets
  FROM legs WHERE platform <> 'fomo' GROUP BY 1
  UNION ALL
  SELECT 'fomo',
         SUM(CASE WHEN rn = 1 THEN amount_usd END),
         COUNT(DISTINCT tx_id),
         CAST(NULL AS bigint)
  FROM fomo_legs
)
SELECT p.platform,
       to_unixtime(CAST(CAST('{{data_day}}' AS date) AS timestamp)) AS data_day_unix,
       p.volume_usd,
       p.txns,
       COALESCE(f.fees_usd, 0) AS fees_usd,
       COALESCE(p.wallets, 0) AS wallets,
       CASE WHEN p.txns > 0 THEN p.volume_usd / p.txns END AS avg_trade_usd,
       CASE WHEN p.volume_usd > 0 THEN COALESCE(f.fees_usd, 0) / p.volume_usd * 100 ELSE 0.0 END AS fee_rate_pct,
       (SELECT price FROM sol_price) AS sol_price_usd,
       (SELECT last_trade_unix FROM day_last_trade) AS day_last_trade_unix
FROM per_platform p
LEFT JOIN platform_fees f ON f.platform = p.platform
WHERE p.volume_usd > 0
ORDER BY p.volume_usd DESC
`

// indexLag is how long after a UTC day closes the harness will read it. Dune's
// Solana tables are usually minutes behind, but DeFiLlama's own Solana adapters
// refuse a day whose end is less than ten hours old, and matching that rule is
// what makes the two sets of figures comparable. The cost is that the data day
// sits one to two days behind, which is why the freshness window defaults to 3.
const indexLag = 10 * time.Hour

// targetDay is the newest UTC day that closed at least indexLag ago.
func targetDay(now time.Time) time.Time {
	return now.UTC().Add(-indexLag).Truncate(24*time.Hour).AddDate(0, 0, -1)
}

// dayIsYesterday reports whether targetDay has caught up to yesterday. The
// refresh waits for this before spending an execution, so the one run a day
// measures yesterday rather than the day before whatever hour the container
// happens to have started at.
func dayIsYesterday(now time.Time) bool {
	return targetDay(now).Equal(now.UTC().Truncate(24*time.Hour).AddDate(0, 0, -1))
}

func dayString(day time.Time) string { return day.Format("2006-01-02") }

const duneBase = "https://api.dune.com/api/v1"

type duneClient struct {
	apiKey string
	http   *http.Client
	// lastExecutionEnded is written from the polling goroutine and read from the
	// main loop, so it is behind a mutex.
	mu                 sync.Mutex
	lastExecutionEnded time.Time
}

type duneRow struct {
	Platform string `json:"platform"`
	// DataDayUnix is 00:00 UTC of the day the figures are for. 0 when the
	// source did not say, which the freshness guard treats as stale.
	DataDayUnix float64 `json:"data_day_unix"`
	// DayLastTradeUnix is the last trade the query saw on the data day, across
	// every platform. A day that is only partly loaded stops short of its end,
	// which the data day alone cannot show because the harness chose it.
	DayLastTradeUnix float64 `json:"day_last_trade_unix"`
	// SolPriceUSD is the day's SOL close. 0 when prices.day had no row, in which
	// case the SOL and wSOL share of the fees is missing and the fee figures are
	// not published.
	SolPriceUSD float64 `json:"sol_price_usd"`
	VolumeUSD   float64 `json:"volume_usd"`
	Txns        float64 `json:"txns"`
	FeesUSD     float64 `json:"fees_usd"`
	Wallets     float64 `json:"wallets"`
	AvgTradeUSD float64 `json:"avg_trade_usd"`
	FeeRatePct  float64 `json:"fee_rate_pct"`
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

const queryName = "OCB: Solana trading platform daily metrics"

// queryParameters declares the data-day macro. Dune needs a default so the query
// can be opened and run in the editor; every execution from here overrides it.
func queryParameters(day time.Time) []any {
	return []any{map[string]any{
		"key":   dayParam,
		"type":  "text",
		"value": dayString(day),
	}}
}

func (d *duneClient) createQuery(day time.Time) (string, error) {
	payload := map[string]any{
		"name":       queryName,
		"query_sql":  querySQL,
		"is_private": false,
		"parameters": queryParameters(day),
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

// storedSQL is the SQL Dune currently holds for a query id.
func (d *duneClient) storedSQL(queryID string) (string, error) {
	resp, err := d.req("GET", "/query/"+queryID, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		QuerySQL string `json:"query_sql"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.QuerySQL, nil
}

// syncQuery makes the SQL in this repo the SQL Dune runs, keeping the query id and
// its history rather than creating a new query beside the old one. It writes only
// when the SQL actually differs: a PATCH bumps the query version and Dune then
// answers /results with 404 until something re-executes, so patching identical SQL
// on every container start would turn each restart into a metered execution.
// Reports whether it wrote.
func (d *duneClient) syncQuery(queryID string, day time.Time) (bool, error) {
	stored, err := d.storedSQL(queryID)
	if err != nil {
		return false, err
	}
	if stored == querySQL {
		return false, nil
	}
	return true, d.updateQuery(queryID, day)
}

func (d *duneClient) updateQuery(queryID string, day time.Time) error {
	payload := map[string]any{
		"name":       queryName,
		"query_sql":  querySQL,
		"parameters": queryParameters(day),
	}
	resp, err := d.req("PATCH", "/query/"+queryID, payload)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

func (d *duneClient) execute(queryID string, day time.Time) (string, error) {
	resp, err := d.req("POST", "/query/"+queryID+"/execute", map[string]any{
		"query_parameters": map[string]string{dayParam: dayString(day)},
	})
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
	// Without this, an error body with no state field decodes to "" and the caller
	// keeps polling a dead execution to its timeout instead of reporting.
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.State, nil
}

// executionResult reads the results of one execution by id. The execution is
// parameterized on the data day, and GET /query/{id}/results takes no parameters,
// so reading back through it means trusting Dune to hand back the run we asked
// for rather than the one matching the query's saved default. perp-volume-history
// reads by execution id for the same reason. latestResult stays for the startup
// path, where there is no execution id to read and whatever ran last is the right
// answer; the freshness guard covers it being old.
func (d *duneClient) executionResult(execID string) ([]duneRow, error) {
	return d.decodeRows("/execution/" + execID + "/results")
}

func (d *duneClient) latestResult(queryID string) ([]duneRow, error) {
	return d.decodeRows("/query/" + queryID + "/results")
}

func (d *duneClient) decodeRows(path string) ([]duneRow, error) {
	resp, err := d.req("GET", path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	var out struct {
		ExecutionEndedAt string `json:"execution_ended_at"`
		Result           struct {
			Rows []duneRow `json:"rows"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if t, err := time.Parse(time.RFC3339Nano, out.ExecutionEndedAt); err == nil {
		d.mu.Lock()
		d.lastExecutionEnded = t
		d.mu.Unlock()
	}
	return out.Result.Rows, nil
}

// resultAge is the age of the newest cached result seen by latestResult,
// or a very large duration before the first successful fetch.
func (d *duneClient) resultAge() time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.lastExecutionEnded.IsZero() {
		return 365 * 24 * time.Hour
	}
	return time.Since(d.lastExecutionEnded)
}
