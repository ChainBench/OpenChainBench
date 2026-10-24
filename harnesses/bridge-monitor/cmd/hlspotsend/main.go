package main

// Move a Hyperliquid spot balance to another HL address.
//
// Written on 2026-10-21 because the wallet rotation missed it. Hyperliquid
// spot holdings are not a token on any chain, so neither the on-chain scans
// nor Mobula's portfolio saw the $2.9985 of USDC that cmd/rebalance had
// deposited into HyperCore months earlier. The perp account read zero and
// HyperliquidClient.Withdrawable reads the perp side, which is why nothing
// flagged it.
//
// spotSend is chosen over withdraw3 for this: withdraw3 charges HL's flat ~$1
// fee and has a $2 minimum, which on a $3 balance is a third of it, while an
// internal spot transfer stays inside HL.
//
// The EIP-712 shape is the same one hyperliquid_withdraw.go uses for
// withdraw3, with SpotSend's own primary type and field list. The domain is
// fixed by HL and a mismatch makes the recovered signer wrong, so HL rejects
// it rather than sending to the wrong place.
//
// Dry run unless --yes.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

const (
	apiBase     = "https://api.hyperliquid.xyz"
	chainName   = "Mainnet"
	sigChainID  = "0xa4b1" // Arbitrum, declared and signed as the same value
	sigChainInt = 42161
)

type spotSendAction struct {
	Type             string `json:"type"`
	HyperliquidChain string `json:"hyperliquidChain"`
	SignatureChainID string `json:"signatureChainId"`
	Destination      string `json:"destination"`
	Token            string `json:"token"`
	Amount           string `json:"amount"`
	Time             uint64 `json:"time"`
}

type signature struct {
	R string `json:"r"`
	S string `json:"s"`
	V uint64 `json:"v"`
}

type exchangeReq struct {
	Action    spotSendAction `json:"action"`
	Nonce     uint64         `json:"nonce"`
	Signature signature      `json:"signature"`
}

func main() {
	to := flag.String("to", "", "destination EVM address on Hyperliquid")
	token := flag.String("token", "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
		"HL spot token identifier, name:tokenId from the spotMeta endpoint")
	amount := flag.String("amount", "", "decimal amount; empty means the whole balance")
	yes := flag.Bool("yes", false, "broadcast")
	flag.Parse()

	dest := strings.ToLower(strings.TrimSpace(*to))
	if !strings.HasPrefix(dest, "0x") || len(dest) != 42 {
		die(fmt.Sprintf("--to is not an address: %q", *to))
	}
	if !strings.Contains(*token, ":") {
		die("--token must be name:tokenId, as spotMeta reports it")
	}

	raw := strings.TrimPrefix(strings.TrimSpace(os.Getenv("WALLET_EVM_PRIVATE_KEY")), "0x")
	if raw == "" {
		die("WALLET_EVM_PRIVATE_KEY is not set")
	}
	key, err := crypto.HexToECDSA(raw)
	if err != nil {
		die(fmt.Sprintf("private key does not parse: %v", err))
	}
	from := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
	if from == dest {
		die("source and destination are the same address")
	}

	coin := strings.SplitN(*token, ":", 2)[0]
	have, err := spotBalance(from, coin)
	if err != nil {
		die(fmt.Sprintf("read spot balance: %v", err))
	}
	fmt.Printf("from %s\nto   %s\nspot %s balance: %s\n", from, dest, coin, have)

	amt := strings.TrimSpace(*amount)
	if amt == "" {
		amt = have
	}
	f, err := strconv.ParseFloat(amt, 64)
	if err != nil || f <= 0 {
		die(fmt.Sprintf("nothing to send (amount %q)", amt))
	}
	// Trim so "2.9985" stays itself and "3.0" becomes "3", which is the form
	// HL expects and the form the signature covers.
	amt = strconv.FormatFloat(f, 'f', -1, 64)
	fmt.Printf("would send %s %s\n", amt, coin)

	if !*yes {
		fmt.Println("dry run, pass --yes to broadcast")
		return
	}

	nonce := uint64(time.Now().UnixMilli())
	action := spotSendAction{
		Type:             "spotSend",
		HyperliquidChain: chainName,
		SignatureChainID: sigChainID,
		Destination:      dest,
		Token:            *token,
		Amount:           amt,
		Time:             nonce,
	}
	digest, err := spotSendDigest(action)
	if err != nil {
		die(fmt.Sprintf("typed data: %v", err))
	}
	sigBytes, err := crypto.Sign(digest, key)
	if err != nil {
		die(fmt.Sprintf("sign: %v", err))
	}
	// crypto.Sign yields [R || S || V] with V in {0,1}; HL wants {27,28}.
	sig := signature{
		R: "0x" + hex.EncodeToString(sigBytes[0:32]),
		S: "0x" + hex.EncodeToString(sigBytes[32:64]),
		V: uint64(sigBytes[64]) + 27,
	}

	body, err := json.Marshal(exchangeReq{Action: action, Nonce: nonce, Signature: sig})
	if err != nil {
		die(fmt.Sprintf("marshal: %v", err))
	}
	resp, err := post(apiBase+"/exchange", body)
	if err != nil {
		die(fmt.Sprintf("exchange: %v", err))
	}
	var out struct {
		Status   string          `json:"status"`
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		die(fmt.Sprintf("parse response: %v (body %s)", err, trim(string(resp), 300)))
	}
	if !strings.EqualFold(out.Status, "ok") {
		die(fmt.Sprintf("HL rejected the transfer: %s", trim(string(resp), 300)))
	}
	fmt.Printf("sent %s %s to %s (nonce %d)\n", amt, coin, dest, nonce)
}

// spotSendDigest mirrors withdraw3Digest in cmd/monitor, with SpotSend's own
// primary type and the token field it adds.
func spotSendDigest(a spotSendAction) ([]byte, error) {
	td := apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"HyperliquidTransaction:SpotSend": []apitypes.Type{
				{Name: "hyperliquidChain", Type: "string"},
				{Name: "destination", Type: "string"},
				{Name: "token", Type: "string"},
				{Name: "amount", Type: "string"},
				{Name: "time", Type: "uint64"},
			},
		},
		PrimaryType: "HyperliquidTransaction:SpotSend",
		Domain: apitypes.TypedDataDomain{
			Name:              "HyperliquidSignTransaction",
			Version:           "1",
			ChainId:           math.NewHexOrDecimal256(sigChainInt),
			VerifyingContract: "0x0000000000000000000000000000000000000000",
		},
		Message: apitypes.TypedDataMessage{
			"hyperliquidChain": a.HyperliquidChain,
			"destination":      a.Destination,
			"token":            a.Token,
			"amount":           a.Amount,
			"time":             new(big.Int).SetUint64(a.Time),
		},
	}
	digest, _, err := apitypes.TypedDataAndHash(td)
	return digest, err
}

func spotBalance(user, coin string) (string, error) {
	body, _ := json.Marshal(map[string]string{"type": "spotClearinghouseState", "user": user})
	resp, err := post(apiBase+"/info", body)
	if err != nil {
		return "", err
	}
	var out struct {
		Balances []struct {
			Coin  string `json:"coin"`
			Total string `json:"total"`
		} `json:"balances"`
	}
	if err := json.Unmarshal(resp, &out); err != nil {
		return "", err
	}
	for _, b := range out.Balances {
		if strings.EqualFold(b.Coin, coin) {
			return b.Total, nil
		}
	}
	return "0", nil
}

func post(url string, body []byte) ([]byte, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func die(m string) {
	fmt.Fprintln(os.Stderr, "error: "+m)
	os.Exit(1)
}
