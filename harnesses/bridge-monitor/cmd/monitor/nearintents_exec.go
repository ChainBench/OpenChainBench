package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	solana "github.com/gagliardetto/solana-go"
	ata "github.com/gagliardetto/solana-go/programs/associated-token-account"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"
)

// Near Intents (1Click) execution: the USDC-only triangle.
//
// Near Intents only lists USDC on Solana / Base / Arbitrum (no Arb USDT), so it
// cannot run the main cross-asset USDC<->USDT triangle. It gets its own
// self-conserving USDC-only triangle (Sol USDC -> Base USDC -> Arb USDC ->
// Sol USDC): each leg returns to start over the full cycle, only fees burn.
// Gated by ENABLE_NEARINTENTS_EXEC (default off), like R4/R5.
//
// 1Click is an intent/solver flow, not a signed-tx bridge: the quote returns a
// deposit address, we send the exact input there ourselves, POST the deposit tx
// hash to /v0/deposit/submit, then poll /v0/status until SUCCESS. Contract per
// the 1Click OpenAPI (quote.depositAddress / depositMemo, SubmitDepositTxRequest
// {txHash, depositAddress, memo}, GET /v0/status?depositAddress -> status enum).

const (
	usdcDecimals            = 6
	nearIntents1ClickBase   = "https://1click.chaindefuser.com"
	nearIntentsSettleWaitMs = 15 * time.Second
)

// SetNearIntents wires the Near Intents client used for the USDC-triangle
// execution path. Called from main after the executor is built.
func (e *Executor) SetNearIntents(ni *NearIntentsBridge) { e.nearIntents = ni }

// GetNearIntentsTriangle returns the USDC-only triangle executed by Near Intents
// when ENABLE_NEARINTENTS_EXEC=true. All legs are native USDC so the intent
// solver supports every hop, and the cycle conserves inventory.
func GetNearIntentsTriangle() []TestRoute {
	return []TestRoute{
		{
			Name:      "NI_USDC_SOL_BASE",
			FromChain: "Solana", FromChainAPI: "solana:solana",
			FromToken: solanaUSDCMint,
			ToChain:   "Base", ToChainAPI: "evm:8453",
			ToToken:     baseUSDCAddr,
			Amounts:     []float64{3, 30},
			UsdAmounts:  []float64{3, 30},
			IsSolanaSrc: true,
		},
		{
			Name:      "NI_USDC_BASE_ARB",
			FromChain: "Base", FromChainAPI: "evm:8453",
			FromToken: baseUSDCAddr,
			ToChain:   "Arbitrum", ToChainAPI: "evm:42161",
			ToToken:    arbUSDCAddr,
			Amounts:    []float64{3, 30},
			UsdAmounts: []float64{3, 30},
		},
		{
			Name:      "NI_USDC_ARB_SOL",
			FromChain: "Arbitrum", FromChainAPI: "evm:42161",
			FromToken: arbUSDCAddr,
			ToChain:   "Solana", ToChainAPI: "solana:solana",
			ToToken:    solanaUSDCMint,
			Amounts:    []float64{3, 30},
			UsdAmounts: []float64{3, 30},
		},
	}
}

// runNearIntentsTriangle runs the USDC-only triangle through Near Intents,
// sequentially, with cascade-stop: a failed leg leaves the next leg's source
// unfunded, so we stop rather than force a revert. Inventory returns to start
// over the full cycle.
func runNearIntentsTriangle(executor *Executor, tier float64) {
	if executor == nil || executor.nearIntents == nil {
		log.Println("⚠️  Near Intents triangle skipped: client unavailable")
		return
	}
	routes := GetNearIntentsTriangle()
	execMu.Lock()
	defer execMu.Unlock()
	log.Printf("🌀 Near Intents USDC triangle $%.0f...", tier)
	for i, route := range routes {
		result := executor.RunBridgeOnRoute("near-intents", route, tier)
		time.Sleep(2 * time.Second)
		if result == nil || !result.Success {
			log.Printf("  ⚠️  NI leg %d (%s) failed — skipping remaining legs (cascade prevention)", i+1, route.Name)
			break
		}
	}
}

// nearIntentsExecQuote is the subset of the 1Click quote response needed to
// execute: where to deposit, the optional memo, and the exact input amount.
type nearIntentsExecQuote struct {
	Quote struct {
		DepositAddress string  `json:"depositAddress"`
		DepositMemo    string  `json:"depositMemo"`
		AmountIn       string  `json:"amountIn"`
		AmountInUsd    string  `json:"amountInUsd"`
		AmountOutUsd   string  `json:"amountOutUsd"`
		TimeEstimate   float64 `json:"timeEstimate"`
	} `json:"quote"`
}

// GetExecutableQuote requests a non-dry 1Click quote and returns the deposit
// target. Unlike the quote-loop GetQuote (dry:true), this commits the solver to
// a deposit address we must fund.
func (n *NearIntentsBridge) GetExecutableQuote(originAsset, destinationAsset, rawAmount, recipient, refundTo string) (*nearIntentsExecQuote, time.Duration, error) {
	start := time.Now()
	deadline := time.Now().UTC().Add(15 * time.Minute).Format("2006-01-02T15:04:05.000Z")
	body := NearIntentsQuoteRequest{
		Dry:                false,
		SwapType:           "EXACT_INPUT",
		SlippageTolerance:  100,
		OriginAsset:        originAsset,
		DepositType:        "ORIGIN_CHAIN",
		DestinationAsset:   destinationAsset,
		Amount:             rawAmount,
		Recipient:          recipient,
		RecipientType:      "DESTINATION_CHAIN",
		RefundTo:           refundTo,
		RefundType:         "ORIGIN_CHAIN",
		Deadline:           deadline,
		QuoteWaitingTimeMs: 3000,
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", nearIntents1ClickBase+"/v0/quote", bytes.NewReader(payload))
	if err != nil {
		return nil, time.Since(start), err
	}
	req.Header.Set("Content-Type", "application/json")
	if n.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+n.apiKey)
	}
	resp, err := n.client.Do(req)
	if err != nil {
		return nil, time.Since(start), err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	lat := time.Since(start)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, lat, fmt.Errorf("near-intents exec quote %d: %s", resp.StatusCode, truncateNI(string(raw), 300))
	}
	var out nearIntentsExecQuote
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, lat, fmt.Errorf("near-intents exec quote decode: %w", err)
	}
	if out.Quote.DepositAddress == "" {
		return nil, lat, fmt.Errorf("near-intents exec quote returned no deposit address: %s", truncateNI(string(raw), 200))
	}
	return &out, lat, nil
}

// SubmitDeposit notifies the 1Click coordinator that the deposit tx was sent,
// so the solver starts settling without waiting to detect the deposit itself.
func (n *NearIntentsBridge) SubmitDeposit(txHash, depositAddress, memo string) error {
	body := map[string]string{"txHash": txHash, "depositAddress": depositAddress}
	if memo != "" {
		body["memo"] = memo
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", nearIntents1ClickBase+"/v0/deposit/submit", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if n.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+n.apiKey)
	}
	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("deposit/submit %d: %s", resp.StatusCode, truncateNI(string(raw), 200))
	}
	return nil
}

// Status returns the current 1Click execution status for a deposit address.
func (n *NearIntentsBridge) Status(depositAddress, memo string) (string, error) {
	q := url.Values{}
	q.Set("depositAddress", depositAddress)
	if memo != "" {
		q.Set("depositMemo", memo)
	}
	req, err := http.NewRequest("GET", nearIntents1ClickBase+"/v0/status?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}
	if n.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+n.apiKey)
	}
	resp, err := n.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, truncateNI(string(raw), 200))
	}
	var out struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("status decode: %w", err)
	}
	return out.Status, nil
}

// executeNearIntents runs one USDC leg through the 1Click intent flow: quote ->
// send the exact input to the deposit address -> submit -> poll to SUCCESS.
func (e *Executor) executeNearIntents(route TestRoute, amountUSD float64, rawUnits string, quoteStart time.Time) (*ExecutionResult, string, error) {
	result := &ExecutionResult{
		Bridge: "near-intents", Route: route, AmountUSD: amountUSD,
		FromChain: route.FromChain, ToChain: route.ToChain,
		FromToken: route.FromToken, ToToken: route.ToToken,
	}
	if e.nearIntents == nil {
		return result, "", fmt.Errorf("near-intents client not configured")
	}

	originAsset, ok := nearIntentsAssetID(route.FromChain, route.FromToken)
	if !ok {
		return result, "", fmt.Errorf("near-intents unsupported origin %s/%s", route.FromChain, route.FromToken)
	}
	destAsset, ok := nearIntentsAssetID(route.ToChain, route.ToToken)
	if !ok {
		return result, "", fmt.Errorf("near-intents unsupported destination %s/%s", route.ToChain, route.ToToken)
	}

	recipient := e.walletManager.EVMAddress
	if route.ToChain == "Solana" {
		recipient = e.walletManager.SolanaAddress
	}
	refundTo := e.walletManager.EVMAddress
	if route.FromChain == "Solana" {
		refundTo = e.walletManager.SolanaAddress
	}

	quote, quoteLat, err := e.nearIntents.GetExecutableQuote(originAsset, destAsset, rawUnits, recipient, refundTo)
	if err != nil {
		return result, "", err
	}
	result.QuoteLatencyMs = quoteLat.Milliseconds()

	// Send the exact input the solver expects to its deposit address.
	sendRaw := quote.Quote.AmountIn
	if sendRaw == "" {
		sendRaw = rawUnits
	}
	broadcastStart := time.Now()
	var txHash string
	if route.FromChain == "Solana" {
		amt, perr := strconv.ParseUint(sendRaw, 10, 64)
		if perr != nil {
			return result, "", fmt.Errorf("parse amountIn %q: %w", sendRaw, perr)
		}
		txHash, err = e.txExecutor.TransferSPL(solanaUSDCMint, quote.Quote.DepositAddress, amt, usdcDecimals)
	} else {
		txHash, err = e.txExecutor.TransferERC20(route.FromChain, route.FromToken, quote.Quote.DepositAddress, sendRaw)
	}
	if err != nil {
		// A send error may follow node acceptance: keep the hash so callers
		// classify this as in-flight, never retry-safe.
		return result, txHash, fmt.Errorf("near-intents deposit transfer failed: %w", err)
	}
	result.TxHash = txHash

	// Best-effort notify; the solver also detects the deposit on-chain.
	if serr := e.nearIntents.SubmitDeposit(txHash, quote.Quote.DepositAddress, quote.Quote.DepositMemo); serr != nil {
		log.Printf("    ⚠️  near-intents deposit/submit failed (solver will still detect on-chain): %v", serr)
	}

	// Poll to settlement.
	status := e.pollNearIntentsSettle(quote.Quote.DepositAddress, quote.Quote.DepositMemo, 5*time.Minute)
	now := time.Now()
	result.ExecutionLatencyMs = now.Sub(broadcastStart).Milliseconds()
	result.E2ELatencyMs = now.Sub(quoteStart).Milliseconds()

	switch status {
	case "SUCCESS":
		result.Success = true
	case "REFUNDED", "FAILED":
		result.Reverted = true
	default:
		// Timed out in PROCESSING/PENDING: terminal-ambiguous. Leave Success
		// false with the TxHash set so the caller treats it as in-flight.
		return result, txHash, fmt.Errorf("near-intents did not settle within timeout (last status %q)", status)
	}

	inUsd := parseFloatOrZero(quote.Quote.AmountInUsd)
	outUsd := parseFloatOrZero(quote.Quote.AmountOutUsd)
	result.OutputUSD = outUsd
	if inUsd > 0 && outUsd > 0 && inUsd >= outUsd {
		result.ActualFeeUSD = inUsd - outUsd
	}
	return result, txHash, nil
}

// pollNearIntentsSettle polls 1Click status until a terminal state or timeout,
// returning the last observed status.
func (e *Executor) pollNearIntentsSettle(depositAddress, memo string, timeout time.Duration) string {
	deadline := time.Now().Add(timeout)
	last := "UNKNOWN"
	for time.Now().Before(deadline) {
		time.Sleep(nearIntentsSettleWaitMs)
		st, err := e.nearIntents.Status(depositAddress, memo)
		if err != nil {
			continue
		}
		last = st
		switch st {
		case "SUCCESS", "REFUNDED", "FAILED":
			return st
		}
	}
	return last
}

// TransferERC20 sends `rawAmount` (base units, decimal string) of an ERC-20 to
// `to` on an EVM chain via a standard transfer(address,uint256) call.
func (tx *TxExecutor) TransferERC20(chain, tokenAddr, to, rawAmount string) (string, error) {
	amt := new(big.Int)
	if _, ok := amt.SetString(strings.TrimSpace(rawAmount), 10); !ok {
		return "", fmt.Errorf("invalid raw amount %q", rawAmount)
	}
	// transfer(address,uint256) selector 0xa9059cbb
	data := append(hexutil.MustDecode("0xa9059cbb"),
		append(common.LeftPadBytes(common.HexToAddress(to).Bytes(), 32),
			common.LeftPadBytes(amt.Bytes(), 32)...)...)
	return tx.ExecuteEVMTransaction(chain, tokenAddr, "0x"+common.Bytes2Hex(data), "0")
}

// TransferSPL sends `rawAmount` base units of an SPL token to the associated
// token account of `toOwner`, creating that ATA idempotently first. Used for
// the Solana-source leg of the Near Intents USDC triangle.
func (tx *TxExecutor) TransferSPL(mintB58, toOwnerB58 string, rawAmount uint64, decimals uint8) (string, error) {
	if tx.dryRun {
		return "dry-run-spl-transfer", nil
	}
	mint, err := solana.PublicKeyFromBase58(mintB58)
	if err != nil {
		return "", fmt.Errorf("invalid mint: %w", err)
	}
	toOwner, err := solana.PublicKeyFromBase58(toOwnerB58)
	if err != nil {
		return "", fmt.Errorf("invalid deposit owner: %w", err)
	}
	owner := tx.solanaPrivateKey.PublicKey()

	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	if err != nil {
		return "", fmt.Errorf("source ATA: %w", err)
	}
	destATA, _, err := solana.FindAssociatedTokenAddress(toOwner, mint)
	if err != nil {
		return "", fmt.Errorf("dest ATA: %w", err)
	}

	createIx := ata.NewCreateIdempotentInstruction(owner, toOwner, mint).Build()
	transferIx := token.NewTransferCheckedInstruction(rawAmount, decimals, sourceATA, mint, destATA, owner, nil).Build()

	ctx := context.Background()
	recent, err := tx.solanaClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", fmt.Errorf("blockhash: %w", err)
	}
	transaction, err := solana.NewTransaction(
		[]solana.Instruction{createIx, transferIx},
		recent.Value.Blockhash,
		solana.TransactionPayer(owner),
	)
	if err != nil {
		return "", fmt.Errorf("build spl tx: %w", err)
	}
	if _, err := transaction.Sign(func(k solana.PublicKey) *solana.PrivateKey {
		if k.Equals(owner) {
			return &tx.solanaPrivateKey
		}
		return nil
	}); err != nil {
		return "", fmt.Errorf("sign spl tx: %w", err)
	}
	sig, err := tx.solanaClient.SendTransaction(ctx, transaction)
	if err != nil {
		if sig != (solana.Signature{}) {
			return sig.String(), fmt.Errorf("send spl tx (may be accepted, sig %s): %w", sig.String(), err)
		}
		return "", fmt.Errorf("send spl tx: %w", err)
	}
	log.Printf("📤 Solana SPL transfer sent: %s", sig.String())
	return sig.String(), nil
}
