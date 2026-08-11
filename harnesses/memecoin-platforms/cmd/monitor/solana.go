package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	solanaRPC = "https://api.mainnet-beta.solana.com"
	usdcMint  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	wsolMint  = "So11111111111111111111111111111111111111112"
	rpcSleep  = 220 * time.Millisecond
)

// Known fee wallet owners confirmed via on-chain analysis of tagged Mobula trades.
// Key = owner address of the token account receiving the fee.
var platformFeeOwners = map[string]string{
	"R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX": "fomo",
}

// Program/system accounts that should never be treated as fee recipients.
var skipAccounts = map[string]bool{
	"11111111111111111111111111111111":               true,
	"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":  true,
	"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb":  true,
	"ComputeBudget111111111111111111111111111111":    true,
	"SysvarC1ock11111111111111111111111111111111":    true,
	"Sysvar1nstructions1111111111111111111111111":    true,
	"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": true,
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr":  true,
	"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo":  true,
	"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": true,
	"CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": true,
	"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": true,
}

var (
	txCache      sync.Map
	txCacheSize  atomic.Int64
	solPriceAtom uint64
)

func setSolPrice(p float64) { atomic.StoreUint64(&solPriceAtom, math.Float64bits(p)) }
func getSolPrice() float64  { return math.Float64frombits(atomic.LoadUint64(&solPriceAtom)) }

func updateSolPrice(client *http.Client) {
	req, _ := http.NewRequest("GET",
		"https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", nil)
	req.Header.Set("User-Agent", "OCBBot/1.0")
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[solprice] %v", err)
		return
	}
	defer resp.Body.Close()
	var data map[string]map[string]float64
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return
	}
	if p, ok := data["solana"]["usd"]; ok && p > 0 {
		setSolPrice(p)
		log.Printf("[solprice] %.2f USD", p)
	}
}

type solanaTxResp struct {
	Result *struct {
		Meta struct {
			Fee               int64    `json:"fee"`
			PreBalances       []int64  `json:"preBalances"`
			PostBalances      []int64  `json:"postBalances"`
			PreTokenBalances  []tokBal `json:"preTokenBalances"`
			PostTokenBalances []tokBal `json:"postTokenBalances"`
		} `json:"meta"`
		Transaction struct {
			Message struct {
				AccountKeys []json.RawMessage `json:"accountKeys"`
			} `json:"message"`
		} `json:"transaction"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type tokBal struct {
	AccountIndex  int    `json:"accountIndex"`
	Mint          string `json:"mint"`
	Owner         string `json:"owner"`
	UITokenAmount struct {
		UIAmount *float64 `json:"uiAmount"`
	} `json:"uiTokenAmount"`
}

// computeExplicitFees returns the explicit on-chain fee in USD for a trade tx:
// gas + known platform fee wallet receipts + heuristic small SOL/USDC recipients.
// AMM LP fees that stay inside pool accounts are not counted.
// Returns 0 on RPC error (logs the failure).
func computeExplicitFees(rpcClient *http.Client, txHash, sender string) float64 {
	if txHash == "" {
		return 0
	}
	if v, ok := txCache.Load(txHash); ok {
		return v.(float64)
	}
	if txCacheSize.Load() > 100_000 {
		txCache.Range(func(k, _ any) bool { txCache.Delete(k); return true })
		txCacheSize.Store(0)
	}
	fee, err := fetchOnChainFee(rpcClient, txHash, sender)
	if err != nil {
		log.Printf("[solana] %s: %v", txHash[:min(12, len(txHash))], err)
		txCache.Store(txHash, float64(0))
		txCacheSize.Add(1)
		return 0
	}
	txCache.Store(txHash, fee)
	txCacheSize.Add(1)
	time.Sleep(rpcSleep)
	return fee
}

func fetchOnChainFee(rpcClient *http.Client, txHash, sender string) (float64, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0", "id": 1,
		"method": "getTransaction",
		"params": []interface{}{txHash, map[string]interface{}{
			"encoding":                       "jsonParsed",
			"maxSupportedTransactionVersion": 0,
		}},
	})
	req, _ := http.NewRequest("POST", solanaRPC, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := rpcClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var out solanaTxResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, fmt.Errorf("decode: %w", err)
	}
	if out.Error != nil {
		return 0, fmt.Errorf("rpc %d: %s", out.Error.Code, out.Error.Message)
	}
	if out.Result == nil {
		return 0, fmt.Errorf("not found")
	}

	meta := out.Result.Meta
	msg := out.Result.Transaction.Message
	solPrice := getSolPrice()

	// Parse account keys (string or {pubkey,...} objects).
	var accounts []string
	for _, raw := range msg.AccountKeys {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			accounts = append(accounts, s)
			continue
		}
		var obj struct {
			Pubkey string `json:"pubkey"`
		}
		if json.Unmarshal(raw, &obj) == nil {
			accounts = append(accounts, obj.Pubkey)
		}
	}

	gasUSD := float64(meta.Fee) / 1e9 * solPrice

	// Token balance deltas by (owner, mint).
	type ownerMint struct{ owner, mint string }
	tokDelta := map[ownerMint]float64{}
	preTok := map[int]tokBal{}
	postTok := map[int]tokBal{}
	for _, t := range meta.PreTokenBalances  { preTok[t.AccountIndex]  = t }
	for _, t := range meta.PostTokenBalances { postTok[t.AccountIndex] = t }

	for idx := range accounts {
		p, hasPre := preTok[idx]
		q, hasPost := postTok[idx]
		if !hasPre && !hasPost {
			continue
		}
		var mint, owner string
		var preAmt, postAmt float64
		if hasPost {
			mint = q.Mint
			owner = q.Owner
			if q.UITokenAmount.UIAmount != nil {
				postAmt = *q.UITokenAmount.UIAmount
			}
		}
		if hasPre {
			if mint == "" {
				mint = p.Mint
				owner = p.Owner
			}
			if p.UITokenAmount.UIAmount != nil {
				preAmt = *p.UITokenAmount.UIAmount
			}
		}
		tokDelta[ownerMint{owner, mint}] += postAmt - preAmt
	}

	// 1. Known platform fee wallet owners (exact, confirmed on-chain).
	var knownFeeUSD float64
	for key, delta := range tokDelta {
		if _, ok := platformFeeOwners[key.owner]; !ok || delta <= 0 {
			continue
		}
		switch key.mint {
		case usdcMint:
			knownFeeUSD += delta
		case wsolMint:
			knownFeeUSD += delta * solPrice
		}
	}

	// 2. Small SOL recipients heuristic (bot fees / referral tips in native SOL).
	// Anything receiving < 5% of the user's net SOL flow that isn't a system account.
	userIdx := -1
	for i, acc := range accounts {
		if acc == sender {
			userIdx = i
			break
		}
	}
	userAbsFlow := int64(0)
	if userIdx >= 0 && userIdx < len(meta.PreBalances) {
		d := meta.PostBalances[userIdx] - meta.PreBalances[userIdx]
		if d < 0 {
			userAbsFlow = -d
		} else {
			userAbsFlow = d
		}
	}

	var smallSolFeeUSD float64
	for i, acc := range accounts {
		if i == userIdx || skipAccounts[acc] {
			continue
		}
		if _, ok := platformFeeOwners[acc]; ok {
			continue
		}
		d := meta.PostBalances[i] - meta.PreBalances[i]
		if d <= 0 {
			continue
		}
		if userAbsFlow > 0 && d < userAbsFlow/20 {
			smallSolFeeUSD += float64(d) / 1e9 * solPrice
		}
	}

	// 3. Small USDC/WSOL token recipients on the input side (Fomo-style referral fees).
	var smallTokFeeUSD float64
	for key, delta := range tokDelta {
		if key.owner != sender || delta >= 0 {
			continue
		}
		if key.mint != usdcMint && key.mint != wsolMint {
			continue
		}
		maxRecv := 0.0
		for k2, d2 := range tokDelta {
			if k2.mint == key.mint && d2 > maxRecv && !skipAccounts[k2.owner] {
				maxRecv = d2
			}
		}
		for k2, d2 := range tokDelta {
			if k2.mint != key.mint || d2 <= 0 || k2.owner == sender {
				continue
			}
			if skipAccounts[k2.owner] {
				continue
			}
			if _, ok := platformFeeOwners[k2.owner]; ok {
				continue
			}
			if maxRecv > 0 && d2 < maxRecv*0.05 {
				switch key.mint {
				case usdcMint:
					smallTokFeeUSD += d2
				case wsolMint:
					smallTokFeeUSD += d2 * solPrice
				}
			}
		}
	}

	return gasUSD + knownFeeUSD + smallSolFeeUSD + smallTokFeeUSD, nil
}
