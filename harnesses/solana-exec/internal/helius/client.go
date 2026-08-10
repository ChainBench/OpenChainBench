package helius

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Client wraps the Solana JSON-RPC API.
// All calls use standard Solana JSON-RPC — no third-party credits required.
type Client struct {
	httpClient *http.Client
	rpcURL     string
}

// New creates a client using the given Solana RPC endpoint.
func New(rpcURL string) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		rpcURL:     rpcURL,
	}
}

// NewWithRPC kept for call-site compat; apiKey is ignored.
func NewWithRPC(_, rpcURL string) *Client {
	return New(rpcURL)
}

// SigEntry is one result from getSignaturesForAddress.
type SigEntry struct {
	Signature string `json:"signature"`
	Slot      uint64 `json:"slot"`
	BlockTime int64  `json:"blockTime"` // unix seconds, may be 0
	Err       any    `json:"err"`       // nil = success
}

// GetSignaturesForAddress fetches up to `limit` finalized signatures for
// `address`, newest-first. `until` is the exclusive upper bound (cursor);
// `before` is the exclusive lower bound for pagination (pass "" for first page).
func (c *Client) GetSignaturesForAddress(ctx context.Context, address string, limit int, until, before string) ([]SigEntry, error) {
	params := map[string]any{
		"limit":      limit,
		"commitment": "finalized",
	}
	if until != "" {
		params["until"] = until
	}
	if before != "" {
		params["before"] = before
	}

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "getSignaturesForAddress",
		"params":  []any{address, params},
	})

	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * time.Second):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.rpcURL, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			resp.Body.Close()
			lastErr = fmt.Errorf("RPC HTTP 429")
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("RPC HTTP %d", resp.StatusCode)
		}

		var out struct {
			Result []SigEntry `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			resp.Body.Close()
			return nil, fmt.Errorf("RPC decode: %w", err)
		}
		resp.Body.Close()
		if out.Error != nil {
			return nil, fmt.Errorf("RPC error %d: %s", out.Error.Code, out.Error.Message)
		}
		return out.Result, nil
	}
	return nil, fmt.Errorf("RPC: %w (after 3 attempts)", lastErr)
}

// NativeTransfer is a SOL transfer derived from pre/post balance diff.
type NativeTransfer struct {
	FromUserAccount string
	ToUserAccount   string
	Amount          int64 // lamports
}

// TokenTransfer is an SPL token transfer derived from pre/post token balance diff.
// Amount is in the token's raw units (e.g. 1 USDC = 1_000_000).
type TokenTransfer struct {
	ToOwner string // wallet that owns the destination token account
	Mint    string // SPL token mint address
	Amount  int64  // raw token units (positive = received)
}

// EnhancedTx is a parsed Solana transaction.
type EnhancedTx struct {
	Signature            string
	Slot                 uint64
	Timestamp            int64 // unix seconds
	Fee                  int64 // total fee lamports
	FeePayer             string
	NativeTransfers      []NativeTransfer
	TokenTransfers       []TokenTransfer
	TransactionError     any
	ComputeUnitsConsumed int64
	// CULimit is the SetComputeUnitLimit value from ComputeBudget instructions.
	// 0 means the instruction was absent (default limit = 200000 per tx).
	CULimit int64
}

const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// decodeBase58 decodes a base58-encoded Solana instruction data string to bytes.
func decodeBase58(s string) []byte {
	var n big.Int
	for _, c := range s {
		idx := strings.IndexRune(b58Alphabet, c)
		if idx < 0 {
			return nil
		}
		n.Mul(&n, big.NewInt(58))
		n.Add(&n, big.NewInt(int64(idx)))
	}
	decoded := n.Bytes()
	leading := 0
	for _, c := range s {
		if c != '1' {
			break
		}
		leading++
	}
	out := make([]byte, leading+len(decoded))
	copy(out[leading:], decoded)
	return out
}

const computeBudgetProgram = "ComputeBudget111111111111111111111111111111"

// GetEnhancedTransactions fetches and parses up to 100 transactions in parallel
// using standard Solana JSON-RPC getTransaction — no third-party credits needed.
// NativeTransfers and TokenTransfers are derived from pre/post balance diffs.
func (c *Client) GetEnhancedTransactions(ctx context.Context, sigs []string) ([]EnhancedTx, error) {
	if len(sigs) == 0 {
		return nil, nil
	}
	if len(sigs) > 100 {
		return nil, fmt.Errorf("batch max 100 sigs, got %d", len(sigs))
	}

	type result struct {
		tx EnhancedTx
		ok bool
	}
	results := make([]result, len(sigs))

	sem := make(chan struct{}, 10)
	var wg sync.WaitGroup
	for i, sig := range sigs {
		i, sig := i, sig
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			tx, err := c.getTransaction(ctx, sig)
			if err != nil {
				return
			}
			results[i] = result{tx: tx, ok: true}
		}()
	}
	wg.Wait()

	txs := make([]EnhancedTx, 0, len(sigs))
	for _, r := range results {
		if r.ok {
			txs = append(txs, r.tx)
		}
	}
	return txs, nil
}

// accountKey handles both legacy (bare string) and v0 (object with pubkey field) formats.
type accountKey struct{ Pubkey string }

func (a *accountKey) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		a.Pubkey = s
		return nil
	}
	var obj struct {
		Pubkey string `json:"pubkey"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return err
	}
	a.Pubkey = obj.Pubkey
	return nil
}

func (c *Client) getTransaction(ctx context.Context, sig string) (EnhancedTx, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "getTransaction",
		"params": []any{sig, map[string]any{
			"encoding":                       "json",
			"commitment":                     "finalized",
			"maxSupportedTransactionVersion": 0,
		}},
	})

	type tokenBalanceEntry struct {
		AccountIndex  int    `json:"accountIndex"`
		Mint          string `json:"mint"`
		Owner         string `json:"owner"`
		UITokenAmount struct {
			Amount string `json:"amount"` // raw integer as string
		} `json:"uiTokenAmount"`
	}

	var out struct {
		Result *struct {
			Slot      uint64 `json:"slot"`
			BlockTime *int64 `json:"blockTime"`
			Transaction struct {
				Message struct {
					AccountKeys  []accountKey `json:"accountKeys"`
					Instructions []struct {
						ProgramIDIndex int    `json:"programIdIndex"`
						Data           string `json:"data"` // base58-encoded
					} `json:"instructions"`
				} `json:"message"`
				Signatures []string `json:"signatures"`
			} `json:"transaction"`
			Meta *struct {
				Err                  any                  `json:"err"`
				Fee                  int64                `json:"fee"`
				PreBalances          []int64              `json:"preBalances"`
				PostBalances         []int64              `json:"postBalances"`
				ComputeUnitsConsumed *int64               `json:"computeUnitsConsumed"`
				PreTokenBalances     []tokenBalanceEntry  `json:"preTokenBalances"`
				PostTokenBalances    []tokenBalanceEntry  `json:"postTokenBalances"`
				LoadedAddresses      *struct {
					Writable []string `json:"writable"`
					Readonly []string `json:"readonly"`
				} `json:"loadedAddresses"`
			} `json:"meta"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}

	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return EnhancedTx{}, ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * time.Second):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.rpcURL, bytes.NewReader(body))
		if err != nil {
			return EnhancedTx{}, err
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			resp.Body.Close()
			lastErr = fmt.Errorf("getTransaction HTTP 429")
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return EnhancedTx{}, fmt.Errorf("getTransaction HTTP %d", resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			resp.Body.Close()
			lastErr = fmt.Errorf("decode: %w", err)
			continue
		}
		resp.Body.Close()
		lastErr = nil
		break
	}
	if lastErr != nil {
		return EnhancedTx{}, fmt.Errorf("getTransaction: %w (after 3 attempts)", lastErr)
	}
	if out.Error != nil {
		return EnhancedTx{}, fmt.Errorf("RPC error %d: %s", out.Error.Code, out.Error.Message)
	}
	if out.Result == nil || out.Result.Meta == nil {
		return EnhancedTx{}, fmt.Errorf("null result for %s", sig)
	}

	r := out.Result
	m := r.Meta

	// Full account key list: static keys + v0 loaded addresses (writable then readonly).
	accounts := make([]accountKey, len(r.Transaction.Message.AccountKeys))
	copy(accounts, r.Transaction.Message.AccountKeys)
	if m.LoadedAddresses != nil {
		for _, addr := range m.LoadedAddresses.Writable {
			accounts = append(accounts, accountKey{Pubkey: addr})
		}
		for _, addr := range m.LoadedAddresses.Readonly {
			accounts = append(accounts, accountKey{Pubkey: addr})
		}
	}

	// NativeTransfers: accounts whose SOL balance increased received SOL.
	var nativeTransfers []NativeTransfer
	for i, key := range accounts {
		if i >= len(m.PreBalances) || i >= len(m.PostBalances) {
			break
		}
		diff := m.PostBalances[i] - m.PreBalances[i]
		if diff > 0 {
			nativeTransfers = append(nativeTransfers, NativeTransfer{ToUserAccount: key.Pubkey, Amount: diff})
		}
	}

	// TokenTransfers: net SPL token gain per (owner, mint).
	// Sum pre and post separately so wallets with multiple ATAs for the same mint
	// are handled correctly — the diff is the net change, not a per-account delta.
	type ownerMint struct{ owner, mint string }
	preTokenAmt := make(map[ownerMint]int64, len(m.PreTokenBalances))
	for _, tb := range m.PreTokenBalances {
		if tb.Owner == "" {
			continue
		}
		amt, _ := strconv.ParseInt(tb.UITokenAmount.Amount, 10, 64)
		preTokenAmt[ownerMint{tb.Owner, tb.Mint}] += amt
	}
	postTokenAmt := make(map[ownerMint]int64, len(m.PostTokenBalances))
	for _, tb := range m.PostTokenBalances {
		if tb.Owner == "" {
			continue // owner field absent on very old txs
		}
		amt, _ := strconv.ParseInt(tb.UITokenAmount.Amount, 10, 64)
		postTokenAmt[ownerMint{tb.Owner, tb.Mint}] += amt
	}
	var tokenTransfers []TokenTransfer
	for key, postAmt := range postTokenAmt {
		diff := postAmt - preTokenAmt[key]
		if diff > 0 {
			tokenTransfers = append(tokenTransfers, TokenTransfer{
				ToOwner: key.owner,
				Mint:    key.mint,
				Amount:  diff,
			})
		}
	}

	var cuConsumed int64
	if m.ComputeUnitsConsumed != nil {
		cuConsumed = *m.ComputeUnitsConsumed
	}

	// Parse ComputeBudget::SetComputeUnitLimit (discriminator 0x03) from instructions.
	// Priority fee = cuPrice × cuLimit / 1_000_000; cuLimit is the correct denominator,
	// not cuConsumed (over-provisioned txs would otherwise show inflated per-CU price).
	var cuLimit int64
	for _, ix := range r.Transaction.Message.Instructions {
		if ix.ProgramIDIndex < 0 || ix.ProgramIDIndex >= len(accounts) {
			continue
		}
		if accounts[ix.ProgramIDIndex].Pubkey != computeBudgetProgram {
			continue
		}
		data := decodeBase58(ix.Data)
		// SetComputeUnitLimit: discriminator[0]==3, limit=uint32LE[1:5]
		if len(data) >= 5 && data[0] == 3 {
			cuLimit = int64(binary.LittleEndian.Uint32(data[1:5]))
			break
		}
	}

	var feePayer string
	if len(accounts) > 0 {
		feePayer = accounts[0].Pubkey
	}

	var blockTime int64
	if r.BlockTime != nil {
		blockTime = *r.BlockTime
	}

	var sig0 string
	if len(r.Transaction.Signatures) > 0 {
		sig0 = r.Transaction.Signatures[0]
	}

	return EnhancedTx{
		Signature:            sig0,
		Slot:                 r.Slot,
		Timestamp:            blockTime,
		Fee:                  m.Fee,
		FeePayer:             feePayer,
		NativeTransfers:      nativeTransfers,
		TokenTransfers:       tokenTransfers,
		TransactionError:     m.Err,
		ComputeUnitsConsumed: cuConsumed,
		CULimit:              cuLimit,
	}, nil
}
