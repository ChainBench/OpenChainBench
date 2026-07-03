package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// erc20BalanceOf calls balanceOf(owner) on an ERC-20 contract via the chain's
// ethclient. Returns the raw token amount (no decimals applied).
func (tx *TxExecutor) erc20BalanceOf(chain string, token, owner common.Address) (*big.Int, error) {
	client := tx.evmClientFor(chain)
	if client == nil {
		return nil, fmt.Errorf("unknown EVM chain: %s", chain)
	}

	// keccak256("balanceOf(address)")[:4] = 0x70a08231
	data := append(hexutil.MustDecode("0x70a08231"), common.LeftPadBytes(owner.Bytes(), 32)...)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &token, Data: data}, nil)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return big.NewInt(0), nil
	}
	return new(big.Int).SetBytes(out), nil
}

// evmClientFor maps a Route chain name (Base / Arbitrum) to the cached ethclient.
func (tx *TxExecutor) evmClientFor(chain string) interface{ CallContract(context.Context, ethereum.CallMsg, *big.Int) ([]byte, error) } {
	switch strings.ToLower(chain) {
	case "base":
		return tx.baseClient
	case "arbitrum":
		return tx.arbitrumClient
	}
	return nil
}

// solanaSPLBalanceOf returns the SPL token balance for `owner` and `mint`. If
// the associated token account does not yet exist (never received this token),
// returns 0 — that's a valid pre-execution state.
func (tx *TxExecutor) solanaSPLBalanceOf(owner solana.PublicKey, mint solana.PublicKey) (*big.Int, error) {
	if tx.solanaClient == nil {
		return nil, fmt.Errorf("solana client not initialized")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := tx.solanaClient.GetTokenAccountsByOwner(ctx, owner, &rpc.GetTokenAccountsConfig{Mint: &mint}, &rpc.GetTokenAccountsOpts{Commitment: rpc.CommitmentConfirmed})
	if err != nil {
		return nil, err
	}
	if out == nil || len(out.Value) == 0 {
		return big.NewInt(0), nil
	}
	// Sum across all token accounts owned by owner for that mint (usually 1).
	total := new(big.Int)
	for _, acc := range out.Value {
		raw := acc.Account.Data.GetBinary()
		// SPL TokenAccount layout: amount is u64 LE at bytes [64..72]
		if len(raw) >= 72 {
			amount := new(big.Int).SetUint64(uint64leAt(raw[64:72]))
			total.Add(total, amount)
		}
	}
	return total, nil
}

func uint64leAt(b []byte) uint64 {
	return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
}

// solanaNativeBalance returns the lamport balance of `owner`.
func (tx *TxExecutor) solanaNativeBalance(owner solana.PublicKey) (*big.Int, error) {
	if tx.solanaClient == nil {
		return nil, fmt.Errorf("solana client not initialized")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := tx.solanaClient.GetBalance(ctx, owner, rpc.CommitmentConfirmed)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetUint64(out.Value), nil
}

// readDestinationBalance returns the balance of the destination token at the
// receiver address, in raw token units (no decimals applied). Used pre/post
// execution to compute the realized fill (not the quote estimate).
//
// For Solana destination: looks up the SPL token account by mint. For "native"
// SOL, pass mint == "So11111111111111111111111111111111111111112" or empty —
// we'll use getBalance instead.
//
// For EVM destination (Base / Arbitrum): standard ERC-20 balanceOf.
func (tx *TxExecutor) readDestinationBalance(chain, tokenAddrOrSymbol, owner string) (*big.Int, error) {
	chainLower := strings.ToLower(chain)
	if chainLower == "solana" {
		ownerKey, err := solana.PublicKeyFromBase58(owner)
		if err != nil {
			return nil, fmt.Errorf("invalid solana owner: %w", err)
		}
		// Native SOL when token is the wrapped-SOL mint, "SOL", or empty.
		if tokenAddrOrSymbol == "" || strings.EqualFold(tokenAddrOrSymbol, "SOL") ||
			tokenAddrOrSymbol == "So11111111111111111111111111111111111111112" {
			return tx.solanaNativeBalance(ownerKey)
		}
		mint, err := solana.PublicKeyFromBase58(tokenAddrOrSymbol)
		if err != nil {
			return nil, fmt.Errorf("invalid solana mint: %w", err)
		}
		return tx.solanaSPLBalanceOf(ownerKey, mint)
	}
	// EVM
	if !strings.HasPrefix(tokenAddrOrSymbol, "0x") {
		return nil, fmt.Errorf("EVM destination token must be a hex address, got %q", tokenAddrOrSymbol)
	}
	return tx.erc20BalanceOf(chain, common.HexToAddress(tokenAddrOrSymbol), common.HexToAddress(owner))
}

// rawDelta returns (after - before) clamped to >= 0.
func rawDelta(after, before *big.Int) *big.Int {
	if after == nil || before == nil {
		return big.NewInt(0)
	}
	d := new(big.Int).Sub(after, before)
	if d.Sign() < 0 {
		return big.NewInt(0)
	}
	return d
}

// rawToFloat divides a raw token amount by 10^decimals.
func rawToFloat(raw *big.Int, decimals int) float64 {
	if raw == nil {
		return 0
	}
	f, _ := new(big.Float).Quo(new(big.Float).SetInt(raw), big.NewFloat(pow10(decimals))).Float64()
	return f
}

func pow10(n int) float64 {
	v := 1.0
	for i := 0; i < n; i++ {
		v *= 10
	}
	return v
}

// Unused encoders kept around to avoid removing imports if we extend the file.
var _ = base64.StdEncoding
var _ = json.Marshal

// destinationUSDPerToken returns the USD price of one unit of the destination
// token. For stablecoins assumes parity ($1). For known meme tokens uses the
// live price cache. New non-stable destinations need to be added here.
func destinationUSDPerToken(route TestRoute) float64 {
	tok := strings.ToUpper(route.ToToken)
	switch {
	case strings.Contains(tok, "BRETT"),
		strings.HasPrefix(tok, "0X532F27101965DD16442E59D40670FAF5EBB142E4"):
		return TokenPriceUSD("BRETT", 0.0072)
	case strings.Contains(tok, "TRUMP"),
		strings.HasPrefix(tok, "6P6XGHYF7AEE6TZKSMFSKO444WQOP15ICUSQI2JFGIPN"):
		return TokenPriceUSD("TRUMP", 2.55)
	}
	// Default: stablecoin (USDC, USDT) → $1
	return 1.0
}

// destinationTokenDecimals returns the decimals used by the destination token.
// Covers everything we currently bridge to (USDC/USDT 6 dec, BRETT 18 dec).
// Falls back to 6 for unknown destinations — safe default for stables.
func destinationTokenDecimals(route TestRoute) int {
	tok := strings.ToUpper(route.ToToken)
	switch {
	case strings.Contains(tok, "BRETT"),
		strings.HasPrefix(tok, "0X532F27101965DD16442E59D40670FAF5EBB142E4"): // BRETT on Base
		return 18
	case strings.Contains(tok, "USDC"), strings.Contains(tok, "USDT"),
		strings.HasPrefix(tok, "0XAF88D065"), // Arb USDC native
		strings.HasPrefix(tok, "0XFD086BC7"), // Arb USDT0
		strings.HasPrefix(tok, "0X833589FC"), // Base USDC
		strings.HasPrefix(tok, "EPJFW"):      // Solana USDC
		return 6
	}
	return 6
}

// pollRealizedFill polls the destination balance until it differs from
// `before` by at least 1 raw unit, up to `timeout`. Returns the post-balance
// once movement is detected, or the latest read on timeout (caller decides
// whether to trust it).
func (tx *TxExecutor) pollRealizedFill(chain, token, owner string, before *big.Int, timeout time.Duration) (*big.Int, error) {
	deadline := time.Now().Add(timeout)
	var last *big.Int = before
	for time.Now().Before(deadline) {
		now, err := tx.readDestinationBalance(chain, token, owner)
		if err != nil {
			time.Sleep(1500 * time.Millisecond)
			continue
		}
		last = now
		if before == nil || now.Cmp(before) > 0 {
			return now, nil
		}
		time.Sleep(1500 * time.Millisecond)
	}
	return last, fmt.Errorf("fill not visible within %s", timeout)
}
