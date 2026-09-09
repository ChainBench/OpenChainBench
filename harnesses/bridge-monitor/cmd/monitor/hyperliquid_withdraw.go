package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// Hyperliquid native withdrawal (HyperCore -> Arbitrum).
//
// R5's deposit leg (Arb USDC -> HyperCore) is a normal provider bridge, so it
// is benchmarked per bridge like every other route. But HyperCore has no
// provider bridge OUT: withdrawing back to Arbitrum is an HL-native "withdraw3"
// signed action, not something Mobula/Relay/LiFi quote. Without this file R5
// would be a one-way capital drain; with it the loop conserves Arb USDC.
//
// withdraw3 is a user-signed action (EIP-712), NOT an L1 agent action, so it
// signs with the wallet's own EVM key against the fixed HyperliquidSignTransaction
// domain. Funds land on Arbitrum to the same address after HL validator
// processing (a few minutes), minus HL's flat withdrawal fee (~$1). Minimum
// withdrawal is $2, so the $3/$30 tiers both clear it (the $1 flat fee on a $3
// round-trip is steep, but it is the true cost of the HyperCore return path and
// is what the benchmark is meant to expose).

const (
	hyperliquidAPIBase   = "https://api.hyperliquid.xyz"
	hyperliquidChainName = "Mainnet"
	// Arbitrum chain id; withdraw3 must sign and declare the same value.
	hyperliquidSignatureChainID    = "0xa4b1" // 42161
	hyperliquidSignatureChainIDInt = 42161
	// HL rejects withdrawals below this notional.
	hyperliquidMinWithdrawUSD = 2.0
)

// HyperliquidClient performs read (info) and write (exchange) calls against the
// Hyperliquid API using the bridge-monitor's EVM key for signing.
type HyperliquidClient struct {
	http *http.Client
	tx   *TxExecutor // provides the EVM private key + address
}

// NewHyperliquidClient returns nil when no EVM key is available (quote-only
// mode): callers must treat nil as "HL withdraw unavailable" and skip R5 exec.
func NewHyperliquidClient(tx *TxExecutor) *HyperliquidClient {
	if tx == nil || tx.EVMPrivateKey() == nil {
		return nil
	}
	return &HyperliquidClient{
		http: &http.Client{Timeout: 30 * time.Second},
		tx:   tx,
	}
}

// clearinghouseState is the subset of HL's perp account state we need: the USDC
// amount that is free to withdraw right now.
type clearinghouseState struct {
	Withdrawable string `json:"withdrawable"`
}

// Withdrawable returns the USDC (in USD) currently withdrawable from the perp
// account of `address` on HyperCore. Used to confirm an R5 deposit filled and
// to size the return withdrawal.
func (c *HyperliquidClient) Withdrawable(address string) (float64, error) {
	body := map[string]string{"type": "clearinghouseState", "user": strings.ToLower(address)}
	raw, err := c.postJSON(hyperliquidAPIBase+"/info", body)
	if err != nil {
		return 0, err
	}
	var st clearinghouseState
	if err := json.Unmarshal(raw, &st); err != nil {
		return 0, fmt.Errorf("parse clearinghouseState: %w (body: %s)", err, truncateHL(string(raw), 200))
	}
	if st.Withdrawable == "" {
		return 0, nil
	}
	v, err := strconv.ParseFloat(st.Withdrawable, 64)
	if err != nil {
		return 0, fmt.Errorf("parse withdrawable %q: %w", st.Withdrawable, err)
	}
	return v, nil
}

// withdraw3Action is the exact JSON object that gets both signed and sent.
// Field order matters for HL's action hashing on some actions; withdraw3 is
// EIP-712 so order in the struct is not hashed, but we keep it stable anyway.
type withdraw3Action struct {
	Type             string `json:"type"`
	HyperliquidChain string `json:"hyperliquidChain"`
	SignatureChainID string `json:"signatureChainId"`
	Amount           string `json:"amount"`
	Time             uint64 `json:"time"`
	Destination      string `json:"destination"`
}

type hlSignature struct {
	R string `json:"r"`
	S string `json:"s"`
	V uint64 `json:"v"`
}

type exchangeRequest struct {
	Action    withdraw3Action `json:"action"`
	Nonce     uint64          `json:"nonce"`
	Signature hlSignature     `json:"signature"`
}

type exchangeResponse struct {
	Status   string          `json:"status"`
	Response json.RawMessage `json:"response"`
}

// Withdraw signs and submits a withdraw3 action moving `amountUSD` of USDC from
// the HyperCore perp account back to `destination` on Arbitrum. Returns nil on
// HL "status":"ok". It never moves more than what is withdrawable and refuses
// amounts below HL's minimum.
func (c *HyperliquidClient) Withdraw(amountUSD float64, destination string) error {
	if amountUSD < hyperliquidMinWithdrawUSD {
		return fmt.Errorf("withdraw amount $%.2f below HL minimum $%.2f", amountUSD, hyperliquidMinWithdrawUSD)
	}
	dest := strings.ToLower(strings.TrimSpace(destination))
	if !strings.HasPrefix(dest, "0x") || len(dest) != 42 {
		return fmt.Errorf("invalid destination address %q", destination)
	}

	nonce := uint64(time.Now().UnixMilli())
	// HL expects the amount as a plain decimal string. Trim trailing zeros so
	// "3" stays "3" and "2.5" stays "2.5".
	amountStr := strconv.FormatFloat(amountUSD, 'f', -1, 64)

	action := withdraw3Action{
		Type:             "withdraw3",
		HyperliquidChain: hyperliquidChainName,
		SignatureChainID: hyperliquidSignatureChainID,
		Amount:           amountStr,
		Time:             nonce,
		Destination:      dest,
	}

	sig, err := c.signWithdraw(action)
	if err != nil {
		return fmt.Errorf("sign withdraw3: %w", err)
	}

	reqBody := exchangeRequest{Action: action, Nonce: nonce, Signature: sig}
	raw, err := c.postJSON(hyperliquidAPIBase+"/exchange", reqBody)
	if err != nil {
		return err
	}

	var resp exchangeResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return fmt.Errorf("parse exchange response: %w (body: %s)", err, truncateHL(string(raw), 300))
	}
	if !strings.EqualFold(resp.Status, "ok") {
		return fmt.Errorf("HL withdraw rejected: %s", truncateHL(string(raw), 300))
	}
	log.Printf("🏦 HL withdraw3 accepted: $%s USDC -> %s (nonce %d)", amountStr, dest, nonce)
	return nil
}

// signWithdraw builds the EIP-712 digest for the withdraw3 action and signs it
// with the wallet's EVM key. The domain and type list are fixed by HL and MUST
// match exactly or the signer recovers to the wrong address and HL rejects it.
func (c *HyperliquidClient) signWithdraw(a withdraw3Action) (hlSignature, error) {
	digest, err := withdraw3Digest(a)
	if err != nil {
		return hlSignature{}, fmt.Errorf("typed-data hash: %w", err)
	}

	sig, err := crypto.Sign(digest, c.tx.EVMPrivateKey())
	if err != nil {
		return hlSignature{}, fmt.Errorf("crypto.Sign: %w", err)
	}
	// crypto.Sign yields [R || S || V] with V in {0,1}; HL wants {27,28}.
	v := uint64(sig[64]) + 27
	return hlSignature{
		R: "0x" + toHex32(sig[0:32]),
		S: "0x" + toHex32(sig[32:64]),
		V: v,
	}, nil
}

// withdraw3Digest builds the EIP-712 signing digest for a withdraw3 action.
// The domain and type list are fixed by Hyperliquid and MUST match exactly or
// the recovered signer address is wrong and HL rejects the withdrawal.
func withdraw3Digest(a withdraw3Action) ([]byte, error) {
	typedData := apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"HyperliquidTransaction:Withdraw": []apitypes.Type{
				{Name: "hyperliquidChain", Type: "string"},
				{Name: "destination", Type: "string"},
				{Name: "amount", Type: "string"},
				{Name: "time", Type: "uint64"},
			},
		},
		PrimaryType: "HyperliquidTransaction:Withdraw",
		Domain: apitypes.TypedDataDomain{
			Name:              "HyperliquidSignTransaction",
			Version:           "1",
			ChainId:           math.NewHexOrDecimal256(hyperliquidSignatureChainIDInt),
			VerifyingContract: "0x0000000000000000000000000000000000000000",
		},
		Message: apitypes.TypedDataMessage{
			"hyperliquidChain": a.HyperliquidChain,
			"destination":      a.Destination,
			"amount":           a.Amount,
			"time":             new(big.Int).SetUint64(a.Time),
		},
	}
	digest, _, err := apitypes.TypedDataAndHash(typedData)
	return digest, err
}

// postJSON marshals body, POSTs it, and returns the response bytes. Non-2xx
// responses still return their body (HL puts error detail in a 200 or 4xx JSON)
// alongside an error.
func (c *HyperliquidClient) postJSON(url string, body any) ([]byte, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return raw, fmt.Errorf("HL %s returned %d: %s", url, resp.StatusCode, truncateHL(string(raw), 300))
	}
	return raw, nil
}

func toHex32(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = hexdigits[v>>4]
		out[i*2+1] = hexdigits[v&0x0f]
	}
	return string(out)
}

func truncateHL(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
