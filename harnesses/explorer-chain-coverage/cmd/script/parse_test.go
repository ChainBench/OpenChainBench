package main

import (
	"testing"
	"time"
)

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// ─── freshness gate ─────────────────────────────────────────────────

func TestFreshEnough(t *testing.T) {
	if !freshEnough(time.Now().Add(-5 * time.Minute)) {
		t.Fatal("5 minutes old must be fresh")
	}
	if freshEnough(time.Now().Add(-3 * time.Hour)) {
		t.Fatal("3 hours old must be stale")
	}
	if freshEnough(time.Time{}) {
		t.Fatal("zero time must be stale")
	}
}

// ─── Blockscout ─────────────────────────────────────────────────────

func TestParseChainscout(t *testing.T) {
	fixture := `{
		"1": {"name":"Ethereum","isTestnet":false,"explorers":[{"url":"https://eth.blockscout.com/","hostedBy":"blockscout"}]},
		"11155111": {"name":"Sepolia","isTestnet":true,"explorers":[{"url":"https://sepolia.blockscout.com","hostedBy":"blockscout"}]},
		"100": {"name":"Gnosis","isTestnet":false,"explorers":[{"url":"https://gnosis.dead.example","hostedBy":"self"},{"url":"https://gnosis.blockscout.com","hostedBy":"blockscout"}]}
	}`
	m, err := parseChainscout([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(m) != 2 {
		t.Fatalf("mainnets = %d, want 2 (testnet filtered)", len(m))
	}
	if got := pickBlockscoutURL(m["100"]); got != "https://gnosis.blockscout.com" {
		t.Fatalf("pick = %q, want the blockscout-hosted instance", got)
	}
	if got := pickBlockscoutURL(m["1"]); got != "https://eth.blockscout.com" {
		t.Fatalf("pick = %q, want trailing slash trimmed", got)
	}
}

func TestParseBlockscoutLatestBlock(t *testing.T) {
	fresh := `{"items":[{"timestamp":"` + iso(time.Now().Add(-2*time.Minute)) + `"}]}`
	ts, err := parseBlockscoutLatestBlock([]byte(fresh))
	if err != nil || !freshEnough(ts) {
		t.Fatalf("fresh block must parse and pass gate: %v", err)
	}
	if _, err := parseBlockscoutLatestBlock([]byte(`{"items":[]}`)); err == nil {
		t.Fatal("empty items must error")
	}
}

// ─── Etherscan ──────────────────────────────────────────────────────

func TestParseEtherscanChainlist(t *testing.T) {
	fixture := `{"result":[
		{"chainname":"Ethereum Mainnet","chainid":"1"},
		{"chainname":"Sepolia Testnet","chainid":"11155111"},
		{"chainname":"Base Mainnet","chainid":"8453"},
		{"chainname":"Holesky","chainid":"17000"}
	]}`
	chains, err := parseEtherscanChainlist([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chains) != 2 {
		// Sepolia caught by the testnet token, Holesky by the holesky
		// token: only Ethereum and Base remain.
		t.Fatalf("mainnets = %d, want 2: %v", len(chains), chains)
	}
}

func TestParseEtherscanBlockNoByTime(t *testing.T) {
	fresh, err := parseEtherscanBlockNoByTime([]byte(`{"status":"1","message":"OK","result":"23456789"}`))
	if err != nil || !fresh {
		t.Fatalf("status 1 must be fresh, got %v %v", fresh, err)
	}
	fresh, err = parseEtherscanBlockNoByTime([]byte(`{"status":"0","message":"No records found","result":""}`))
	if err != nil || fresh {
		t.Fatalf("no records = stale, not error: %v %v", fresh, err)
	}
	if _, err := parseEtherscanBlockNoByTime([]byte(`{"status":"0","message":"NOTOK","result":"Max rate limit reached"}`)); err == nil {
		t.Fatal("rate limit must surface as error")
	}
	if _, err := parseEtherscanBlockNoByTime([]byte(`{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}`)); err == nil {
		t.Fatal("auth must surface as error")
	}
}

// ─── Routescan ──────────────────────────────────────────────────────

func TestParseRoutescanChains(t *testing.T) {
	chains, err := parseRoutescanChains([]byte(`{"items":[{"chainId":"1","name":"Ethereum"},{"chainId":"43114","name":"Avalanche"}]}`))
	if err != nil || len(chains) != 2 {
		t.Fatalf("wrapped shape: %v %v", chains, err)
	}
	chains, err = parseRoutescanChains([]byte(`[{"chainId":"10","name":"Optimism"}]`))
	if err != nil || len(chains) != 1 {
		t.Fatalf("bare array shape: %v %v", chains, err)
	}
}

func TestParseRoutescanLatestBlock(t *testing.T) {
	fresh := `{"items":[{"timestamp":"` + iso(time.Now().Add(-1*time.Minute)) + `","number":123}]}`
	ts, err := parseRoutescanLatestBlock([]byte(fresh))
	if err != nil || !freshEnough(ts) {
		t.Fatalf("fresh block must pass: %v", err)
	}
}

// ─── Blockchair ─────────────────────────────────────────────────────

func TestParseBlockchairAggregate(t *testing.T) {
	chains, err := parseBlockchairAggregate([]byte(`{"data":{"bitcoin":{},"ethereum":{},"litecoin":{}}}`))
	if err != nil || len(chains) != 3 {
		t.Fatalf("aggregate: %v %v", chains, err)
	}
}

func TestParseBlockchairBestBlockTime(t *testing.T) {
	fresh := `{"data":{"best_block_time":"` + time.Now().UTC().Add(-10*time.Minute).Format("2006-01-02 15:04:05") + `"}}`
	ts, err := parseBlockchairBestBlockTime([]byte(fresh))
	if err != nil || !freshEnough(ts) {
		t.Fatalf("fresh best_block_time must pass: %v", err)
	}
	stale := `{"data":{"best_block_time":"2020-01-01 00:00:00"}}`
	ts, err = parseBlockchairBestBlockTime([]byte(stale))
	if err != nil || freshEnough(ts) {
		t.Fatal("2020 block must be stale")
	}
}

// ─── Subscan ────────────────────────────────────────────────────────

func TestParseSubscanNetworks(t *testing.T) {
	html := []byte(`docs: https://polkadot.api.subscan.io/api/scan/blocks and
		kusama.api.subscan.io plus pro.api.subscan.io and polkadot.api.subscan.io again`)
	nets := parseSubscanNetworks(html)
	if len(nets) != 2 || nets[0] != "kusama" || nets[1] != "polkadot" {
		t.Fatalf("networks = %v, want [kusama polkadot] deduped, pro filtered", nets)
	}
}

func TestParseSubscanLatestBlock(t *testing.T) {
	fresh := []byte(`{"data":{"blocks":[{"block_timestamp":` + timeNowUnixMinus(2*time.Minute) + `}]}}`)
	ts, err := parseSubscanLatestBlock(fresh)
	if err != nil || !freshEnough(ts) {
		t.Fatalf("fresh block must pass: %v", err)
	}
}

func timeNowUnixMinus(d time.Duration) string {
	return timeToUnixStr(time.Now().Add(-d))
}

func timeToUnixStr(t time.Time) string {
	return fmtInt(t.Unix())
}

func fmtInt(i int64) string {
	// tiny helper avoiding strconv import churn in tests
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

// ─── OKLink ─────────────────────────────────────────────────────────

func TestParseOKLinkSummary(t *testing.T) {
	freshMs := time.Now().Add(-4 * time.Minute).UnixMilli()
	staleMs := time.Now().Add(-5 * time.Hour).UnixMilli()
	fixture := `{"code":"0","msg":"","data":[
		{"chainShortName":"ETH","chainFullName":"Ethereum","lastBlockTime":"` + fmtInt(freshMs) + `"},
		{"chainShortName":"BTC","chainFullName":"Bitcoin","lastBlockTime":"` + fmtInt(staleMs) + `"}
	]}`
	rows, err := parseOKLinkSummary([]byte(fixture))
	if err != nil || len(rows) != 2 {
		t.Fatalf("summary: %v %v", rows, err)
	}
	if !freshEnough(rows[0].lastBlock) || freshEnough(rows[1].lastBlock) {
		t.Fatal("freshness gate mismatch on oklink rows")
	}
	if _, err := parseOKLinkSummary([]byte(`{"code":"50111","msg":"invalid key","data":[]}`)); err == nil {
		t.Fatal("api error code must surface")
	}
}

// ─── top50 ──────────────────────────────────────────────────────────

func TestTop50Count(t *testing.T) {
	if len(top50) != 50 {
		t.Fatalf("pinned list must hold exactly 50 entries, has %d", len(top50))
	}
	evm := map[int64]bool{1: true, 8453: true}
	names := map[string]bool{"bitcoin": true, "solana": true, "kusama": true}
	if got := top50Count(evm, names); got != 4 {
		t.Fatalf("top50Count = %d, want 4 (eth, base, btc, sol; kusama not in list)", got)
	}
}
