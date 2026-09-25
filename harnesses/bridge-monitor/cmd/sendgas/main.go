// sendgas moves a small amount of native ETH from the execution wallet to
// another address. Same chain (Base or Arbitrum): a plain transfer. Another
// chain (for example Ethereum mainnet, where the wallet holds nothing): a
// Relay intent whose recipient is the destination address, paid from the
// origin chain. One-shot operator utility, meant to run inside the monitor
// container so it reads the same WALLET_EVM_PRIVATE_KEY, BASE_RPC and
// ARB_RPC as cmd/monitor. Nothing here is scheduled; the caller passes
// --yes to broadcast.
//
//	sendgas --chain base --to 0x... --amount 0.001 --yes
//	sendgas --chain arbitrum --dest ethereum --to 0x... --amount 0.0025 --yes
//
// Guards: amount capped at 0.01 ETH per call, the wallet must keep at least
// --keep ETH (default 0.003) after value + worst-case gas so the triangle's
// next leg is never starved, and a Relay quote is refused when it returns
// less than --min-out of the input. Raise the caps with the flags, never by
// editing this file in a hurry.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
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
	relayAPI           = "https://api.relay.link"
	nativeToken        = "0x0000000000000000000000000000000000000000"
)

type chainCfg struct {
	name    string
	chainID *big.Int
	rpcEnv  []string
	rpcDef  string
}

// Origin chains: the two EVM chains the wallet holds gas on.
var origins = map[string]chainCfg{
	"base":     {name: "Base", chainID: big.NewInt(8453), rpcEnv: []string{"BASE_RPC"}, rpcDef: defaultBaseRPC},
	"arbitrum": {name: "Arbitrum", chainID: big.NewInt(42161), rpcEnv: []string{"ARB_RPC", "ARBITRUM_RPC"}, rpcDef: defaultArbitrumRPC},
}

// Destination chains Relay can deliver native ETH to from an origin above.
var destinations = map[string]int64{
	"ethereum": 1,
	"base":     8453,
	"arbitrum": 42161,
	"optimism": 10,
}

func main() {
	chainFlag := flag.String("chain", "", "origin chain the wallet pays from: base or arbitrum")
	destFlag := flag.String("dest", "", "destination chain (ethereum, base, arbitrum, optimism); empty = same as --chain")
	toFlag := flag.String("to", "", "recipient 0x address")
	amountFlag := flag.String("amount", "", "ETH amount spent on the origin chain, decimal (e.g. 0.001)")
	maxFlag := flag.String("max", "0.01", "refuse amounts above this many ETH")
	keepFlag := flag.String("keep", "0.003", "ETH the wallet must keep on the origin chain after value + gas")
	minOut := flag.Float64("min-out", 0.9, "cross-chain only: refuse a Relay quote returning less than this share of the input")
	yes := flag.Bool("yes", false, "broadcast (without it the tool only prints the plan)")
	flag.Parse()

	cfg, ok := origins[strings.ToLower(*chainFlag)]
	if !ok {
		log.Fatalf("--chain must be base or arbitrum")
	}
	dest := strings.ToLower(*destFlag)
	if dest == "" {
		dest = strings.ToLower(*chainFlag)
	}
	destID, ok := destinations[dest]
	if !ok {
		log.Fatalf("--dest must be one of ethereum, base, arbitrum, optimism")
	}
	crossChain := destID != cfg.chainID.Int64()
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
	if to == (common.Address{}) {
		log.Fatalf("recipient is the zero address")
	}

	rpc := cfg.rpcDef
	for _, env := range cfg.rpcEnv {
		if v := strings.TrimSpace(os.Getenv(env)); v != "" {
			rpc = v
			break
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
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

	// The transaction we sign: a plain transfer, or Relay's deposit step.
	txTo := to
	var txData []byte
	txValue := value
	var checkURL string
	if crossChain {
		q, err := relayQuote(ctx, from, to, cfg.chainID.Int64(), destID, value)
		if err != nil {
			log.Fatalf("relay quote: %v", err)
		}
		step, err := q.depositStep(cfg.chainID.Int64())
		if err != nil {
			log.Fatalf("relay quote: %v", err)
		}
		out, ok := new(big.Int).SetString(q.Details.CurrencyOut.Amount, 10)
		if !ok {
			log.Fatalf("relay quote: unreadable output amount %q", q.Details.CurrencyOut.Amount)
		}
		share := new(big.Float).Quo(new(big.Float).SetInt(out), new(big.Float).SetInt(value))
		shareF, _ := share.Float64()
		log.Printf("relay %s -> %s: in %s ETH ($%s), out %s ETH ($%s) = %.1f%% of input, fees relayer $%s + service $%s, ~%d s",
			cfg.name, dest, fmtEth(value), q.Details.CurrencyIn.AmountUsd, fmtEth(out), q.Details.CurrencyOut.AmountUsd,
			shareF*100, q.Fees.Relayer.AmountUsd, q.Fees.RelayerService.AmountUsd, q.Details.TimeEstimate)
		if shareF < *minOut {
			log.Fatalf("quote returns %.1f%% of the input, below --min-out %.0f%%", shareF*100, *minOut*100)
		}
		if !strings.EqualFold(q.Details.Recipient, to.Hex()) {
			log.Fatalf("quote recipient %s is not %s", q.Details.Recipient, to.Hex())
		}
		if !common.IsHexAddress(step.Data.To) {
			log.Fatalf("relay step has no valid to address")
		}
		txTo = common.HexToAddress(step.Data.To)
		txData = common.FromHex(step.Data.Data)
		txValue, ok = new(big.Int).SetString(strings.TrimPrefix(step.Data.Value, "0x"), pickBase(step.Data.Value))
		if !ok || txValue.Cmp(value) != 0 {
			log.Fatalf("relay step value %q does not match the requested amount", step.Data.Value)
		}
		checkURL = relayAPI + step.Check.Endpoint
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
	gasLimit, err := client.EstimateGas(ctx, ethereum.CallMsg{From: from, To: &txTo, Value: txValue, Data: txData, GasPrice: gasPrice})
	if err != nil {
		log.Fatalf("estimate gas: %v", err)
	}
	gasLimit = gasLimit * 12 / 10
	gasCost := new(big.Int).Mul(gasPrice, new(big.Int).SetUint64(gasLimit))
	after := new(big.Int).Sub(balance, new(big.Int).Add(txValue, gasCost))
	if after.Cmp(keepWei) < 0 {
		log.Fatalf("would leave %s ETH on %s, below the %s ETH floor (balance %s)",
			fmtEth(after), cfg.name, fmtEth(keepWei), fmtEth(balance))
	}
	nonce, err := client.PendingNonceAt(ctx, from)
	if err != nil {
		log.Fatalf("nonce: %v", err)
	}
	// The monitor serializes its own broadcasts behind an in-process mutex
	// that this tool cannot take (cmd/monitor/spend_tracker.go). A pending
	// nonce ahead of the mined one means one of its transactions is in
	// flight right now: signing the same nonce would race it, and the
	// balance read above would not see its spend. Refuse and let the
	// operator retry once the slot is over (review of PR 2686).
	mined, err := client.NonceAt(ctx, from, nil)
	if err != nil {
		log.Fatalf("mined nonce: %v", err)
	}
	if mined != nonce {
		log.Fatalf("a transaction from %s is in flight on %s (mined nonce %d, pending %d), retry once it is confirmed",
			from.Hex(), cfg.name, mined, nonce)
	}

	log.Printf("%s: %s -> %s (%s), %s ETH, balance %s ETH, gas limit %d, up to %s ETH gas, %s ETH left after",
		cfg.name, from.Hex(), to.Hex(), dest, fmtEth(txValue), fmtEth(balance), gasLimit, fmtEth(gasCost), fmtEth(after))
	if !*yes {
		log.Printf("dry run, pass --yes to broadcast")
		return
	}

	tx := types.NewTransaction(nonce, txTo, txValue, gasLimit, gasPrice, txData)
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
			break
		}
		select {
		case <-ctx.Done():
			log.Fatalf("no receipt yet for %s, check the explorer", signed.Hash().Hex())
		case <-time.After(2 * time.Second):
		}
	}
	if checkURL != "" {
		status, err := relayWait(ctx, checkURL)
		if err != nil {
			log.Fatalf("relay fill: %v (deposit %s is on chain, follow %s)", err, signed.Hash().Hex(), checkURL)
		}
		log.Printf("relay status %s, destination tx %s", status.Status, strings.Join(status.OutTxHashes, ","))
	}
}

type relayQuoteResp struct {
	Details struct {
		Recipient    string `json:"recipient"`
		TimeEstimate int    `json:"timeEstimate"`
		CurrencyIn   struct {
			AmountUsd string `json:"amountUsd"`
		} `json:"currencyIn"`
		CurrencyOut struct {
			Amount    string `json:"amount"`
			AmountUsd string `json:"amountUsd"`
		} `json:"currencyOut"`
	} `json:"details"`
	Fees struct {
		Relayer struct {
			AmountUsd string `json:"amountUsd"`
		} `json:"relayer"`
		RelayerService struct {
			AmountUsd string `json:"amountUsd"`
		} `json:"relayerService"`
	} `json:"fees"`
	Steps []relayStep `json:"steps"`
}

type relayStep struct {
	ID    string `json:"id"`
	Items []struct {
		Data struct {
			To      string `json:"to"`
			Data    string `json:"data"`
			Value   string `json:"value"`
			ChainID int64  `json:"chainId"`
		} `json:"data"`
		Check struct {
			Endpoint string `json:"endpoint"`
		} `json:"check"`
	} `json:"items"`
}

type relayStepItem = struct {
	Data struct {
		To      string `json:"to"`
		Data    string `json:"data"`
		Value   string `json:"value"`
		ChainID int64  `json:"chainId"`
	} `json:"data"`
	Check struct {
		Endpoint string `json:"endpoint"`
	} `json:"check"`
}

// depositStep returns the single origin-chain transaction of a native
// transfer quote. Anything else (approvals, several items) means Relay
// changed shape or the currency was not native; refuse rather than guess.
func (q *relayQuoteResp) depositStep(originID int64) (*relayStepItem, error) {
	if len(q.Steps) != 1 || len(q.Steps[0].Items) != 1 {
		return nil, fmt.Errorf("expected one step with one item, got %d steps", len(q.Steps))
	}
	it := q.Steps[0].Items[0]
	if it.Data.ChainID != originID {
		return nil, fmt.Errorf("step targets chain %d, expected %d", it.Data.ChainID, originID)
	}
	if !strings.HasPrefix(it.Check.Endpoint, "/intents/status") {
		return nil, fmt.Errorf("unexpected check endpoint %q", it.Check.Endpoint)
	}
	return &it, nil
}

func relayQuote(ctx context.Context, from, to common.Address, originID, destID int64, amount *big.Int) (*relayQuoteResp, error) {
	body, _ := json.Marshal(map[string]any{
		"user":                from.Hex(),
		"recipient":           to.Hex(),
		"originChainId":       originID,
		"destinationChainId":  destID,
		"originCurrency":      nativeToken,
		"destinationCurrency": nativeToken,
		"amount":              amount.String(),
		"tradeType":           "EXACT_INPUT",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, relayAPI+"/quote", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if k := strings.TrimSpace(os.Getenv("RELAY_API_KEY")); k != "" {
		req.Header.Set("x-api-key", k)
	}
	resp, err := (&http.Client{Timeout: 45 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relay %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out relayQuoteResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

type relayStatus struct {
	Status      string   `json:"status"`
	Details     string   `json:"details"`
	OutTxHashes []string `json:"txHashes"`
}

func relayWait(ctx context.Context, url string) (*relayStatus, error) {
	deadline := time.Now().Add(5 * time.Minute)
	hc := &http.Client{Timeout: 10 * time.Second}
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := hc.Do(req)
		if err == nil {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			var s relayStatus
			if json.Unmarshal(raw, &s) == nil && s.Status != "" {
				switch strings.ToLower(s.Status) {
				case "success", "filled", "settled":
					return &s, nil
				case "refund", "failure":
					return nil, fmt.Errorf("relay reports %s: %s", s.Status, s.Details)
				}
				log.Printf("relay status %s", s.Status)
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return nil, fmt.Errorf("no terminal status after 5 minutes")
}

func pickBase(v string) int {
	if strings.HasPrefix(v, "0x") {
		return 16
	}
	return 10
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
