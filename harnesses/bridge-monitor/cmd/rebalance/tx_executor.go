package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type TxExecutorSimple struct {
	solanaKey    solana.PrivateKey
	evmKey       []byte
	mobulaAPIKey string
	mobula       *MobulaBridgeSimple
}

var chainRPCs = map[string]string{
	"evm:8453":  "https://mainnet.base.org",
	"evm:42161": "https://arb1.arbitrum.io/rpc",
}

func NewTxExecutorSimple(solPrivKey, evmPrivKey, mobulaAPIKey string) (*TxExecutorSimple, error) {
	// Parse Solana key
	solKey, err := solana.PrivateKeyFromBase58(solPrivKey)
	if err != nil {
		return nil, fmt.Errorf("invalid solana key: %w", err)
	}

	// Parse EVM key
	evmKeyHex := strings.TrimPrefix(evmPrivKey, "0x")
	evmKey, err := hex.DecodeString(evmKeyHex)
	if err != nil {
		return nil, fmt.Errorf("invalid evm key: %w", err)
	}

	return &TxExecutorSimple{
		solanaKey:    solKey,
		evmKey:       evmKey,
		mobulaAPIKey: mobulaAPIKey,
		mobula:       NewMobulaBridgeSimple(mobulaAPIKey),
	}, nil
}

func (tx *TxExecutorSimple) ExecuteSolanaTx(serializedTxBase64 string) (string, error) {
	// Decode base64 TX
	txBytes, err := base64.StdEncoding.DecodeString(serializedTxBase64)
	if err != nil {
		return "", fmt.Errorf("failed to decode tx: %w", err)
	}

	// Deserialize transaction
	transaction, err := solana.TransactionFromBytes(txBytes)
	if err != nil {
		return "", fmt.Errorf("failed to deserialize tx: %w", err)
	}

	// Connect to Solana
	client := rpc.New("https://api.mainnet-beta.solana.com")

	// Get fresh blockhash (the one in the TX may have expired)
	recent, err := client.GetLatestBlockhash(context.Background(), rpc.CommitmentFinalized)
	if err != nil {
		return "", fmt.Errorf("failed to get blockhash: %w", err)
	}
	transaction.Message.RecentBlockhash = recent.Value.Blockhash

	// Clear old signatures and re-sign
	transaction.Signatures = nil
	_, err = transaction.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(tx.solanaKey.PublicKey()) {
			return &tx.solanaKey
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("failed to sign tx: %w", err)
	}

	// Send transaction
	sig, err := client.SendTransaction(context.Background(), transaction)
	if err != nil {
		return "", fmt.Errorf("failed to send tx: %w", err)
	}

	return sig.String(), nil
}

func (tx *TxExecutorSimple) ExecuteEVMTx(chain, to, data, value string) (string, error) {
	rpcURL, ok := chainRPCs[chain]
	if !ok {
		return "", fmt.Errorf("unknown chain: %s", chain)
	}

	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return "", fmt.Errorf("failed to connect: %w", err)
	}
	defer client.Close()

	// Parse private key
	privateKey, err := crypto.ToECDSA(tx.evmKey)
	if err != nil {
		return "", fmt.Errorf("invalid key: %w", err)
	}

	fromAddr := crypto.PubkeyToAddress(privateKey.PublicKey)
	toAddr := common.HexToAddress(to)

	// Parse data
	dataBytes, err := hex.DecodeString(strings.TrimPrefix(data, "0x"))
	if err != nil {
		return "", fmt.Errorf("invalid data: %w", err)
	}

	// Parse value
	valueBig := new(big.Int)
	if value != "" && value != "0" {
		value = strings.TrimPrefix(value, "0x")
		valueBig.SetString(value, 16)
	}

	// Get nonce
	nonce, err := client.PendingNonceAt(context.Background(), fromAddr)
	if err != nil {
		return "", fmt.Errorf("failed to get nonce: %w", err)
	}

	// Get gas price + 50% buffer to handle base-fee variance (esp. Arbitrum)
	gasPrice, err := client.SuggestGasPrice(context.Background())
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}
	gasPrice = new(big.Int).Mul(gasPrice, big.NewInt(150))
	gasPrice = new(big.Int).Div(gasPrice, big.NewInt(100))

	// Estimate gas
	gasLimit := uint64(500000) // Safe default

	// Get chain ID
	chainID, err := client.NetworkID(context.Background())
	if err != nil {
		return "", fmt.Errorf("failed to get chain ID: %w", err)
	}

	// Create transaction
	txData := types.NewTransaction(nonce, toAddr, valueBig, gasLimit, gasPrice, dataBytes)

	// Sign transaction
	signedTx, err := types.SignTx(txData, types.NewEIP155Signer(chainID), privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign: %w", err)
	}

	// Send transaction
	err = client.SendTransaction(context.Background(), signedTx)
	if err != nil {
		return "", fmt.Errorf("failed to send: %w", err)
	}

	return signedTx.Hash().Hex(), nil
}

func (tx *TxExecutorSimple) PollMobulaStatus(txHash string, timeout time.Duration) (*MobulaStatusResp, error) {
	deadline := time.Now().Add(timeout)
	pollInterval := 5 * time.Second

	for time.Now().Before(deadline) {
		status, err := tx.mobula.GetStatus(txHash)
		if err != nil {
			log.Printf("  Status poll error: %v", err)
			time.Sleep(pollInterval)
			continue
		}

		log.Printf("  Status: %s", status.Data.Status)

		if status.Data.Status == "filled" || status.Data.Status == "settled" ||
			status.Data.Status == "refunded" || status.Data.Status == "failed" {
			return status, nil
		}

		time.Sleep(pollInterval)
	}

	return nil, fmt.Errorf("timeout waiting for status")
}
