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
	rpcSleep  = 40 * time.Millisecond
)

// Known fee wallet owners keyed by their Solana address.
// These receive explicit fee transfers in each trade transaction.
// Confirmed via on-chain analysis of tagged Mobula trades.
var platformFeeOwners = map[string]string{
	"R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX": "fomo",
}

// System/program accounts to skip when detecting fee wallets.
var skipAccounts = map[string]bool{
	"11111111111111111111111111111111":                true,
	"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":   true,
	"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb":   true,
	"ComputeBudget111111111111111111111111111111":     true,
	"SysvarC1ock11111111111111111111111111111111":     true,
	"Sysvar1nstructions1111111111111111111111111":     true,
	"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL":  true,
	"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr":   true,
	"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo":   true, // Meteora DLMM
	"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK":  true, // Raydium CLMM
	"CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C":  true, // Raydium CPMM
	"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8":  true, // Raydium AMM v4
	"pumpSwap11111111111111111111111111111111111":     true, // placeholder
}

var (
	txCache      sync.Map
	solPriceAtom uint64 // atomic float64 bits
)

func setSolPrice(p float64) { atomic.StoreUint64(&solPriceAtom, math.Float64bits(p)) }
func getSolPrice() float64  { return math.Float64frombits(atomic.LoadUint64(&solPriceAtom)) }

func updateSolPrice(client *http.Client) {
	req, _ := http.NewRequest("GET",
		"https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", nil)
	req.Header.Set("User-Agent", "OCBBot/1.0")
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[solprice] fetch error: %v", err)
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
			Fee               int64      `json:"fee"`
			PreBalances       []int64    `json:"preBalances"`
			PostBalances      []int64    `json:"postBalances"`
			PreTokenBalances  []tokBal   `json:"preTokenBalances"`
			PostTokenBalances []tokBal   `json:"postTokenBalances"`
		} `json:"meta"`
		Transaction struct {
			Message struct {
				AccountKeys []json.RawMessage `json:"accountKeys"`
			} `json:"message"`
		} `json:"transaction"`
	} `json:"result"`
}

type tokBal struct {
	AccountIndex  int    `json:"accountIndex"`
	Mint          string `json:"mint"`
	Owner         string `json:"owner"`
	UITokenAmount struct {
		UIAmount *float64 `json:"uiAmount"`
	} `json:"uiTokenAmount"`
}

// computeExplicitFees returns the on-chain explicit fee in USD for a given trade tx.
// It captures: gas + known platform fee wallet transfers + small SOL/USDC recipients
// (referral tips, bot fees). AMM LP fees that stay in pools are excluded.
// Returns 0 on any RPC error (logs the error).
func computeExplicitFees(rpcClient *http.Client, txHash, sender string) float64 {
	if txHash == "" {
		return 0
	}
	if v, ok := txCache.Load(txHash); ok {
		return v.(float64)
	}
	fee, err := fetchOnChainFee(rpcClient, txHash, sender)
	if err != nil {
		log.Printf("[solana] %s: %v", txHash[:12], err)
		txCache.Store(txHash, float64(0))
		return 0
	}
	txCache.Store(txHash, fee)
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
	if out.Result == nil {
		return 0, fmt.Errorf("tx not found (pruned?)")
	}

	meta := out.Result.Meta
	msg := out.Result.Transaction.Message
	solPrice := getSolPrice()

	// Parse account keys (can be string or {pubkey, signer, writable}).
	accounts := make([]string, 0, len(msg.AccountKeys))
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

	// Gas fee.
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

	// 1. Known platform fee wallet transfers (exact, confirmed addresses).
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

	// 2. Small SOL recipients heuristic (bot fees, referral tips paid in native SOL).
	// A "small" recipient is one that gets < 5% of the user's absolute SOL flow.
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
			continue // already counted above
		}
		d := meta.PostBalances[i] - meta.PreBalances[i]
		if d <= 0 {
			continue
		}
		if userAbsFlow > 0 && d < userAbsFlow/20 {
			smallSolFeeUSD += float64(d) / 1e9 * solPrice
		}
	}

	// 3. Small token recipients of USDC/WSOL input (Fomo-style referral in input token).
	var smallTokFeeUSD float64
	for key, delta := range tokDelta {
		if key.owner != sender || delta >= 0 {
			continue
		}
		if key.mint != usdcMint && key.mint != wsolMint {
			continue
		}
		// Find max positive recipient of this mint (the pool).
		maxRecv := 0.0
		for k2, d2 := range tokDelta {
			if k2.mint == key.mint && d2 > maxRecv && !skipAccounts[k2.owner] {
				maxRecv = d2
			}
		}
		// Sum any small recipient that isn't the pool or a known fee wallet.
		for k2, d2 := range tokDelta {
			if k2.mint != key.mint || d2 <= 0 || k2.owner == sender {
				continue
			}
			if skipAccounts[k2.owner] {
				continue
			}
			if _, ok := platformFeeOwners[k2.owner]; ok {
				continue // already in knownFeeUSD
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
