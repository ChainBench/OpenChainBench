package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// TxExecutor handles real transaction signing and broadcasting
type TxExecutor struct {
	// Solana
	solanaClient     *rpc.Client
	solanaPrivateKey solana.PrivateKey

	// EVM clients (Base, Arbitrum)
	baseClient     *ethclient.Client
	arbitrumClient *ethclient.Client
	evmPrivateKey  *ecdsa.PrivateKey
	evmAddress     common.Address

	// HTTP client for status polling
	httpClient *http.Client

	// API keys for status polling
	mobulaAPIKey string

	// Config
	dryRun bool
}

// Default public RPCs. Override via SOLANA_RPC / BASE_RPC / ARB_RPC env vars
// (e.g. when public endpoints rate-limit us).
const (
	defaultSolanaRPC   = "https://api.mainnet-beta.solana.com"
	defaultBaseRPC     = "https://mainnet.base.org"
	defaultArbitrumRPC = "https://arb1.arbitrum.io/rpc"
)

func rpcURL(envKey, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		return v
	}
	return fallback
}

// NewTxExecutor creates a new transaction executor
func NewTxExecutor(solPrivKey, evmPrivKey, mobulaAPIKey string, dryRun bool) (*TxExecutor, error) {
	tx := &TxExecutor{
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		mobulaAPIKey: mobulaAPIKey,
		dryRun:       dryRun,
	}

	// Parse Solana private key (base58)
	if solPrivKey != "" {
		privKey, err := solana.PrivateKeyFromBase58(solPrivKey)
		if err != nil {
			return nil, fmt.Errorf("invalid solana private key: %w", err)
		}
		tx.solanaPrivateKey = privKey
		log.Printf("✅ Solana wallet: %s", privKey.PublicKey().String())
	}

	// Parse EVM private key (hex)
	if evmPrivKey != "" {
		privKey, err := crypto.HexToECDSA(strings.TrimPrefix(evmPrivKey, "0x"))
		if err != nil {
			return nil, fmt.Errorf("invalid EVM private key: %w", err)
		}
		tx.evmPrivateKey = privKey
		tx.evmAddress = crypto.PubkeyToAddress(privKey.PublicKey)
		log.Printf("✅ EVM wallet: %s", tx.evmAddress.Hex())
	}

	// Connect to RPCs (only if not dry-run)
	if !dryRun {
		var err error

		solURL := rpcURL("SOLANA_RPC", defaultSolanaRPC)
		baseURL := rpcURL("BASE_RPC", defaultBaseRPC)
		arbURL := rpcURL("ARB_RPC", defaultArbitrumRPC)

		tx.solanaClient = rpc.New(solURL)

		tx.baseClient, err = ethclient.Dial(baseURL)
		if err != nil {
			return nil, fmt.Errorf("failed to connect to Base RPC: %w", err)
		}

		tx.arbitrumClient, err = ethclient.Dial(arbURL)
		if err != nil {
			return nil, fmt.Errorf("failed to connect to Arbitrum RPC: %w", err)
		}

		log.Printf("✅ Connected to Solana (%s), Base (%s), Arbitrum (%s)", solURL, baseURL, arbURL)
	}

	return tx, nil
}

// CanExecute returns true if we have the keys to execute
func (tx *TxExecutor) CanExecute() bool {
	return tx.solanaPrivateKey != nil && tx.evmPrivateKey != nil && !tx.dryRun
}

// EVMPrivateKey exposes the loaded EVM key so the Mobula client can EIP-712
// sign the bridge intent on the confirm step. Returns nil in quote-only mode
// (no key configured), which GetSignedQuote handles by degrading to unsigned.
func (tx *TxExecutor) EVMPrivateKey() *ecdsa.PrivateKey {
	return tx.evmPrivateKey
}

// ExecuteSolanaTransaction signs and broadcasts a Solana transaction
func (tx *TxExecutor) ExecuteSolanaTransaction(serializedTxBase64 string) (string, error) {
	if tx.dryRun {
		return "dry-run-solana-tx", nil
	}

	ctx := context.Background()

	// Decode base64 transaction
	txBytes, err := base64.StdEncoding.DecodeString(serializedTxBase64)
	if err != nil {
		return "", fmt.Errorf("failed to decode tx: %w", err)
	}

	// Parse transaction
	transaction, err := solana.TransactionFromBytes(txBytes)
	if err != nil {
		return "", fmt.Errorf("failed to parse tx: %w", err)
	}

	// Get fresh blockhash (the one from API might be expired)
	recentBlockhash, err := tx.solanaClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", fmt.Errorf("failed to get blockhash: %w", err)
	}
	transaction.Message.RecentBlockhash = recentBlockhash.Value.Blockhash

	// Sign transaction with fresh blockhash
	_, err = transaction.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(tx.solanaPrivateKey.PublicKey()) {
			return &tx.solanaPrivateKey
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("failed to sign tx: %w", err)
	}

	// Send transaction. Same send-ambiguity rule as the EVM path: a send
	// error can follow node acceptance, so surface the signature when the
	// client returns one and let callers treat it as in-flight.
	sig, err := tx.solanaClient.SendTransaction(ctx, transaction)
	if err != nil {
		if sig != (solana.Signature{}) {
			return sig.String(), fmt.Errorf("failed to send tx (may be accepted, sig %s): %w", sig.String(), err)
		}
		return "", fmt.Errorf("failed to send tx: %w", err)
	}

	log.Printf("📤 Solana TX sent: %s", sig.String())
	return sig.String(), nil
}

// ExecuteSolanaFromInstructions builds and broadcasts a Solana TX from Relay instructions
func (tx *TxExecutor) ExecuteSolanaFromInstructions(instructions []RelaySolanaInstruction, lookupTables []string) (string, error) {
	if tx.dryRun {
		return "dry-run-solana-instructions-tx", nil
	}

	ctx := context.Background()

	// Build instructions
	var solInstructions []solana.Instruction
	for _, inst := range instructions {
		// Parse program ID
		programID, err := solana.PublicKeyFromBase58(inst.ProgramId)
		if err != nil {
			return "", fmt.Errorf("invalid program ID %s: %w", inst.ProgramId, err)
		}

		// Parse keys
		var accounts []*solana.AccountMeta
		for _, key := range inst.Keys {
			pubkey, err := solana.PublicKeyFromBase58(key.Pubkey)
			if err != nil {
				return "", fmt.Errorf("invalid pubkey %s: %w", key.Pubkey, err)
			}
			accounts = append(accounts, &solana.AccountMeta{
				PublicKey:  pubkey,
				IsSigner:   key.IsSigner,
				IsWritable: key.IsWritable,
			})
		}

		// Parse instruction data (hex-encoded)
		data, err := hex.DecodeString(strings.TrimPrefix(inst.Data, "0x"))
		if err != nil {
			return "", fmt.Errorf("invalid instruction data: %w", err)
		}

		solInstructions = append(solInstructions, solana.NewInstruction(programID, accounts, data))
	}

	// Get fresh blockhash
	recentBlockhash, err := tx.solanaClient.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", fmt.Errorf("failed to get blockhash: %w", err)
	}

	// Build transaction
	transaction, err := solana.NewTransaction(
		solInstructions,
		recentBlockhash.Value.Blockhash,
		solana.TransactionPayer(tx.solanaPrivateKey.PublicKey()),
	)
	if err != nil {
		return "", fmt.Errorf("failed to create tx: %w", err)
	}

	// Sign transaction
	_, err = transaction.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(tx.solanaPrivateKey.PublicKey()) {
			return &tx.solanaPrivateKey
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("failed to sign tx: %w", err)
	}

	// Send transaction. Same send-ambiguity rule as the EVM path: a send
	// error can follow node acceptance, so surface the signature when the
	// client returns one and let callers treat it as in-flight.
	sig, err := tx.solanaClient.SendTransaction(ctx, transaction)
	if err != nil {
		if sig != (solana.Signature{}) {
			return sig.String(), fmt.Errorf("failed to send tx (may be accepted, sig %s): %w", sig.String(), err)
		}
		return "", fmt.Errorf("failed to send tx: %w", err)
	}

	log.Printf("📤 Solana TX (from instructions) sent: %s", sig.String())
	return sig.String(), nil
}

// ExecuteEVMTransaction signs and broadcasts an EVM transaction
func (tx *TxExecutor) ExecuteEVMTransaction(chain string, to string, data string, value string) (string, error) {
	if tx.dryRun {
		return "dry-run-evm-tx", nil
	}

	// Select client based on chain
	var client *ethclient.Client
	var chainID *big.Int
	switch strings.ToLower(chain) {
	case "base":
		client = tx.baseClient
		chainID = big.NewInt(8453)
	case "arbitrum":
		client = tx.arbitrumClient
		chainID = big.NewInt(42161)
	default:
		return "", fmt.Errorf("unsupported chain: %s", chain)
	}

	ctx := context.Background()

	// Get nonce
	nonce, err := client.PendingNonceAt(ctx, tx.evmAddress)
	if err != nil {
		return "", fmt.Errorf("failed to get nonce: %w", err)
	}

	// Get gas price with 50% buffer to handle rapid base fee increases (esp. Arbitrum)
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}
	// Bump gas price by 50% to avoid "max fee per gas less than block base fee" errors
	gasPrice = new(big.Int).Mul(gasPrice, big.NewInt(150))
	gasPrice = new(big.Int).Div(gasPrice, big.NewInt(100))

	// Parse value. Mobula returns decimal (e.g. "17000000000000002" wei = 0.017 ETH);
	// Relay/LiFi return hex ("0x..."). Auto-detect by 0x prefix — the previous
	// always-hex code interpreted "17000000000000002" as 0x17000000000000002 = 26.5
	// ETH, busting ETH-native bridges with "insufficient funds for gas * price + value".
	valueBig := big.NewInt(0)
	if value != "" && value != "0" && value != "0x0" {
		if strings.HasPrefix(value, "0x") {
			valueBig.SetString(strings.TrimPrefix(value, "0x"), 16)
		} else {
			valueBig.SetString(value, 10)
		}
	}

	// Parse data
	dataBytes := common.FromHex(data)

	// Parse to address
	toAddr := common.HexToAddress(to)

	// Estimate gas
	gasLimit := uint64(500000) // Default, should be estimated

	// Create transaction
	evmTx := types.NewTransaction(nonce, toAddr, valueBig, gasLimit, gasPrice, dataBytes)

	// Sign transaction
	signer := types.NewEIP155Signer(chainID)
	signedTx, err := types.SignTx(evmTx, signer, tx.evmPrivateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign tx: %w", err)
	}

	// Send transaction. On error the node may STILL have accepted the tx
	// (RPC timeout after acceptance): return the locally computed hash so
	// callers classify this as in-flight, never as retry-safe. Discarding
	// it caused the residual double-send hole found in review pass 2.
	txHash := signedTx.Hash().Hex()
	err = client.SendTransaction(ctx, signedTx)
	if err != nil {
		return txHash, fmt.Errorf("failed to send tx (may be accepted, hash %s): %w", txHash, err)
	}

	log.Printf("📤 %s TX sent: %s", chain, txHash)
	return txHash, nil
}

// ApproveERC20 sends an ERC20 approve transaction
func (tx *TxExecutor) ApproveERC20(chain, tokenAddress, spender, amount string) (string, error) {
	if tx.dryRun {
		return "dry-run-approval-tx", nil
	}

	// ERC20 approve(address spender, uint256 amount) selector: 0x095ea7b3
	spenderAddr := common.HexToAddress(spender)

	// Parse amount
	amountBig := new(big.Int)
	amountBig.SetString(amount, 10)

	// Build calldata: function selector + spender (32 bytes) + amount (32 bytes)
	data := make([]byte, 68)
	copy(data[0:4], []byte{0x09, 0x5e, 0xa7, 0xb3}) // approve selector
	copy(data[4:36], common.LeftPadBytes(spenderAddr.Bytes(), 32))
	copy(data[36:68], common.LeftPadBytes(amountBig.Bytes(), 32))

	return tx.ExecuteEVMTransaction(chain, tokenAddress, "0x"+hex.EncodeToString(data), "0")
}

// CheckEVMTxStatus checks if an EVM transaction succeeded or failed
func (tx *TxExecutor) CheckEVMTxStatus(chain string, txHash string) (bool, error) {
	var client *ethclient.Client
	switch strings.ToLower(chain) {
	case "base":
		client = tx.baseClient
	case "arbitrum":
		client = tx.arbitrumClient
	default:
		return false, fmt.Errorf("unsupported chain: %s", chain)
	}

	ctx := context.Background()
	receipt, err := client.TransactionReceipt(ctx, common.HexToHash(txHash))
	if err != nil {
		return false, err // TX not mined yet or error
	}

	// Status 1 = success, 0 = failure/revert
	return receipt.Status == 1, nil
}

// BridgeStatus represents the status of a bridge transaction
type BridgeStatus struct {
	Status    string // "pending", "filled", "refunded", "failed"
	TxHash    string
	ToTxHash  string
	LatencyMs int64
}

// PollMobulaStatus polls Mobula bridge status until completion
func (tx *TxExecutor) PollMobulaStatus(txHash string, timeout time.Duration) (*BridgeStatus, error) {
	if tx.dryRun {
		return &BridgeStatus{Status: "filled", TxHash: txHash, LatencyMs: 5000}, nil
	}

	deadline := time.Now().Add(timeout)
	pollInterval := 5 * time.Second

	for time.Now().Before(deadline) {
		status, err := tx.getMobulaStatus(txHash)
		if err != nil {
			log.Printf("⚠️  Mobula status poll error: %v", err)
			time.Sleep(pollInterval)
			continue
		}

		// Terminal statuses: filled, settled (cross-chain complete), refunded, failed
		if status.Status == "filled" || status.Status == "settled" || status.Status == "refunded" || status.Status == "failed" {
			return status, nil
		}

		log.Printf("⏳ Mobula status: %s (waiting...)", status.Status)
		time.Sleep(pollInterval)
	}

	return nil, fmt.Errorf("timeout waiting for bridge completion")
}

func (tx *TxExecutor) getMobulaStatus(txHash string) (*BridgeStatus, error) {
	url := fmt.Sprintf("https://demo-api.mobula.io/api/2/bridge/status/%s", txHash)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	// Header only - no query param (per Mobula docs)
	if tx.mobulaAPIKey == "" {
		return nil, fmt.Errorf("mobula API key is empty")
	}
	req.Header.Set("Authorization", tx.mobulaAPIKey)

	resp, err := tx.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status API error %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Data struct {
			Status    string `json:"status"`
			LatencyMs int64  `json:"latencyMs"`
			ToTxHash  string `json:"toTxHash"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	return &BridgeStatus{
		Status:    result.Data.Status,
		TxHash:    txHash,
		ToTxHash:  result.Data.ToTxHash,
		LatencyMs: result.Data.LatencyMs,
	}, nil
}

// PollLiFiStatus polls Li.Fi bridge status until completion
func (tx *TxExecutor) PollLiFiStatus(txHash, fromChain, toChain string, timeout time.Duration) (*BridgeStatus, error) {
	if tx.dryRun {
		return &BridgeStatus{Status: "filled", TxHash: txHash, LatencyMs: 5000}, nil
	}

	deadline := time.Now().Add(timeout)
	pollInterval := 5 * time.Second

	for time.Now().Before(deadline) {
		status, err := tx.getLiFiStatus(txHash, fromChain, toChain)
		if err != nil {
			log.Printf("⚠️  Li.Fi status poll error: %v", err)
			time.Sleep(pollInterval)
			continue
		}

		// Li.Fi uses: PENDING, DONE, FAILED
		if status.Status == "DONE" {
			status.Status = "filled"
			return status, nil
		}
		if status.Status == "FAILED" {
			status.Status = "failed"
			return status, nil
		}

		log.Printf("⏳ Li.Fi status: %s (waiting...)", status.Status)
		time.Sleep(pollInterval)
	}

	return nil, fmt.Errorf("timeout waiting for bridge completion")
}

func (tx *TxExecutor) getLiFiStatus(txHash, fromChain, toChain string) (*BridgeStatus, error) {
	url := fmt.Sprintf("https://li.quest/v1/status?txHash=%s&fromChain=%s&toChain=%s",
		txHash, fromChain, toChain)

	resp, err := tx.httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status API error %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Status   string `json:"status"`
		Sending  struct{ TxHash string `json:"txHash"` } `json:"sending"`
		Received struct{ TxHash string `json:"txHash"` } `json:"received"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	return &BridgeStatus{
		Status:   result.Status,
		TxHash:   result.Sending.TxHash,
		ToTxHash: result.Received.TxHash,
	}, nil
}

// PollRelayStatus polls Relay bridge status until completion
func (tx *TxExecutor) PollRelayStatus(requestID string, timeout time.Duration) (*BridgeStatus, error) {
	if tx.dryRun {
		return &BridgeStatus{Status: "filled", TxHash: requestID, LatencyMs: 5000}, nil
	}

	deadline := time.Now().Add(timeout)
	pollInterval := 5 * time.Second

	for time.Now().Before(deadline) {
		status, err := tx.getRelayStatus(requestID)
		if err != nil {
			log.Printf("⚠️  Relay status poll error: %v", err)
			time.Sleep(pollInterval)
			continue
		}

		// Relay uses: pending, success, refunded
		if status.Status == "success" {
			status.Status = "filled"
			return status, nil
		}
		if status.Status == "refunded" || status.Status == "failed" {
			return status, nil
		}

		log.Printf("⏳ Relay status: %s (waiting...)", status.Status)
		time.Sleep(pollInterval)
	}

	return nil, fmt.Errorf("timeout waiting for bridge completion")
}

func (tx *TxExecutor) getRelayStatus(requestID string) (*BridgeStatus, error) {
	url := fmt.Sprintf("https://api.relay.link/intents/status/v3?requestId=%s", requestID)

	resp, err := tx.httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status API error %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Status string `json:"status"`
		TxHash string `json:"txHash"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	return &BridgeStatus{
		Status: result.Status,
		TxHash: result.TxHash,
	}, nil
}

// Close closes all connections
func (tx *TxExecutor) Close() {
	if tx.baseClient != nil {
		tx.baseClient.Close()
	}
	if tx.arbitrumClient != nil {
		tx.arbitrumClient.Close()
	}
}
