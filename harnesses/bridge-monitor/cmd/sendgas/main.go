// sendgas moves a small amount of native ETH from the execution wallet to
// another address on Base or Arbitrum. One-shot operator utility, meant to
// run inside the monitor container so it reads the same WALLET_EVM_PRIVATE_KEY,
// BASE_RPC and ARB_RPC as cmd/monitor. Nothing here is scheduled; the caller
// passes --yes to broadcast.
//
//	sendgas --chain base --to 0x... --amount 0.001 --yes
//
// Guards: amount capped at 0.01 ETH per call, and the wallet must keep at
// least --keep ETH (default 0.003) after value + worst-case gas so the
// triangle's next leg is never starved. Both caps are deliberate; raise them
// with the flags, never by editing this file in a hurry.
package main

import (
	"context"
	"crypto/ecdsa"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	defaultBaseRPC     = "https://mainnet.base.org"
	defaultArbitrumRPC = "https://arb1.arbitrum.io/rpc"
)

type chainCfg struct {
	name    string
	chainID *big.Int
	rpcEnv  []string
	rpcDef  string
}

var chains = map[string]chainCfg{
	"base":     {name: "Base", chainID: big.NewInt(8453), rpcEnv: []string{"BASE_RPC"}, rpcDef: defaultBaseRPC},
	"arbitrum": {name: "Arbitrum", chainID: big.NewInt(42161), rpcEnv: []string{"ARB_RPC", "ARBITRUM_RPC"}, rpcDef: defaultArbitrumRPC},
}

func main() {
	chainFlag := flag.String("chain", "", "base or arbitrum")
	toFlag := flag.String("to", "", "recipient 0x address")
	amountFlag := flag.String("amount", "", "ETH amount, decimal (e.g. 0.001)")
	maxFlag := flag.String("max", "0.01", "refuse amounts above this many ETH")
	keepFlag := flag.String("keep", "0.003", "ETH the wallet must keep after value + gas")
	yes := flag.Bool("yes", false, "broadcast (without it the tool only prints the plan)")
	flag.Parse()

	cfg, ok := chains[strings.ToLower(*chainFlag)]
	if !ok {
		log.Fatalf("--chain must be base or arbitrum")
	}
	if !common.IsHexAddress(*toFlag) {
		log.Fatalf("--to is not a valid address")
	}
	to := common.HexToAddress(*toFlag)
	value, err := parseEth(*amountFlag)
	if err != nil {
		log.Fatalf("--amount: %v", err)
	}
	maxWei, err := parseEth(*maxFlag)
	if err != nil {
		log.Fatalf("--max: %v", err)
	}
	keepWei, err := parseEth(*keepFlag)
	if err != nil {
		log.Fatalf("--keep: %v", err)
	}
	if value.Sign() <= 0 || value.Cmp(maxWei) > 0 {
		log.Fatalf("amount %s ETH outside (0, %s]", fmtEth(value), fmtEth(maxWei))
	}

	key, from, err := loadKey()
	if err != nil {
		log.Fatalf("wallet: %v", err)
	}
	if to == from {
		log.Fatalf("recipient is the execution wallet itself")
	}

	rpc := cfg.rpcDef
	for _, env := range cfg.rpcEnv {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			rpc = v
			break
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client, err := ethclient.DialContext(ctx, rpc)
	if err != nil {
		log.Fatalf("dial %s: %v", cfg.name, err)
	}
	defer client.Close()
	netID, err := client.ChainID(ctx)
	if err != nil {
		log.Fatalf("chain id: %v", err)
	}
	if netID.Cmp(cfg.chainID) != 0 {
		log.Fatalf("RPC answers chain %s, expected %s", netID, cfg.chainID)
	}

	balance, err := client.BalanceAt(ctx, from, nil)
	if err != nil {
		log.Fatalf("balance: %v", err)
	}
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		log.Fatalf("gas price: %v", err)
	}
	// Same 50 % bump as cmd/monitor so a rising base fee does not strand the tx.
	gasPrice = new(big.Int).Div(new(big.Int).Mul(gasPrice, big.NewInt(150)), big.NewInt(100))
	// Estimate rather than hardcode 21000: Arbitrum folds the L1 data cost
	// into the intrinsic gas, so a plain transfer needs more than that there
	// ("intrinsic gas too low" on the first run of this tool).
	gasLimit, err := client.EstimateGas(ctx, ethereum.CallMsg{From: from, To: &to, Value: value, GasPrice: gasPrice})
	if err != nil {
		log.Fatalf("estimate gas: %v", err)
	}
	gasLimit = gasLimit * 12 / 10
	gasCost := new(big.Int).Mul(gasPrice, new(big.Int).SetUint64(gasLimit))
	after := new(big.Int).Sub(balance, new(big.Int).Add(value, gasCost))
	if after.Cmp(keepWei) < 0 {
		log.Fatalf("would leave %s ETH on %s, below the %s ETH floor (balance %s)",
			fmtEth(after), cfg.name, fmtEth(keepWei), fmtEth(balance))
	}
	nonce, err := client.PendingNonceAt(ctx, from)
	if err != nil {
		log.Fatalf("nonce: %v", err)
	}

	log.Printf("%s: %s -> %s, %s ETH, balance %s ETH, gas limit %d, up to %s ETH gas, %s ETH left after",
		cfg.name, from.Hex(), to.Hex(), fmtEth(value), fmtEth(balance), gasLimit, fmtEth(gasCost), fmtEth(after))
	if !*yes {
		log.Printf("dry run, pass --yes to broadcast")
		return
	}

	tx := types.NewTransaction(nonce, to, value, gasLimit, gasPrice, nil)
	signed, err := types.SignTx(tx, types.NewEIP155Signer(cfg.chainID), key)
	if err != nil {
		log.Fatalf("sign: %v", err)
	}
	if err := client.SendTransaction(ctx, signed); err != nil {
		log.Fatalf("send (hash %s, may still be accepted): %v", signed.Hash().Hex(), err)
	}
	log.Printf("sent %s", signed.Hash().Hex())

	for {
		rcpt, err := client.TransactionReceipt(ctx, signed.Hash())
		if err == nil {
			if rcpt.Status != types.ReceiptStatusSuccessful {
				log.Fatalf("tx %s reverted in block %d", signed.Hash().Hex(), rcpt.BlockNumber.Uint64())
			}
			log.Printf("confirmed in block %d, gas used %d", rcpt.BlockNumber.Uint64(), rcpt.GasUsed)
			return
		}
		select {
		case <-ctx.Done():
			log.Fatalf("no receipt yet for %s, check the explorer", signed.Hash().Hex())
		case <-time.After(2 * time.Second):
		}
	}
}

func loadKey() (*ecdsa.PrivateKey, common.Address, error) {
	raw := strings.TrimPrefix(strings.TrimSpace(os.Getenv("WALLET_EVM_PRIVATE_KEY")), "0x")
	if raw == "" {
		return nil, common.Address{}, fmt.Errorf("WALLET_EVM_PRIVATE_KEY is empty")
	}
	key, err := crypto.HexToECDSA(raw)
	if err != nil {
		return nil, common.Address{}, fmt.Errorf("WALLET_EVM_PRIVATE_KEY does not parse")
	}
	from := crypto.PubkeyToAddress(key.PublicKey)
	if want := strings.TrimSpace(os.Getenv("WALLET_EVM_ADDRESS")); want != "" && !strings.EqualFold(want, from.Hex()) {
		return nil, common.Address{}, fmt.Errorf("key derives %s but WALLET_EVM_ADDRESS is %s", from.Hex(), want)
	}
	return key, from, nil
}

// parseEth turns a decimal ETH string into wei without float rounding.
func parseEth(s string) (*big.Int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("empty")
	}
	whole, frac, _ := strings.Cut(s, ".")
	if len(frac) > 18 {
		return nil, fmt.Errorf("more than 18 decimals")
	}
	frac += strings.Repeat("0", 18-len(frac))
	if whole == "" {
		whole = "0"
	}
	wei, ok := new(big.Int).SetString(whole+frac, 10)
	if !ok {
		return nil, fmt.Errorf("not a decimal number")
	}
	return wei, nil
}

func fmtEth(wei *big.Int) string {
	f := new(big.Float).SetPrec(128).Quo(new(big.Float).SetInt(wei), big.NewFloat(1e18))
	return f.Text('f', 6)
}
