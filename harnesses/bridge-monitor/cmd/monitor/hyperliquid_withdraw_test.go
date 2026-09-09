package main

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// TestSignWithdrawRecoversSigner proves the withdraw3 EIP-712 signature is
// internally consistent: signing with the wallet key and recovering from the
// same digest yields the wallet's own address. This validates the domain, type
// list, digest, and the v=27/28 normalization without needing the live HL API.
func TestSignWithdrawRecoversSigner(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	want := crypto.PubkeyToAddress(key.PublicKey)

	c := NewHyperliquidClient(&TxExecutor{evmPrivateKey: key})
	if c == nil {
		t.Fatal("NewHyperliquidClient returned nil with a key present")
	}

	action := withdraw3Action{
		Type:             "withdraw3",
		HyperliquidChain: hyperliquidChainName,
		SignatureChainID: hyperliquidSignatureChainID,
		Amount:           "30",
		Time:             1725000000000,
		Destination:      strings.ToLower(want.Hex()),
	}

	sig, err := c.signWithdraw(action)
	if err != nil {
		t.Fatalf("signWithdraw: %v", err)
	}
	if sig.V != 27 && sig.V != 28 {
		t.Fatalf("v not normalized to 27/28: got %d", sig.V)
	}

	digest, err := withdraw3Digest(action)
	if err != nil {
		t.Fatalf("digest: %v", err)
	}

	raw := make([]byte, 65)
	copy(raw[0:32], common.FromHex(sig.R))
	copy(raw[32:64], common.FromHex(sig.S))
	raw[64] = byte(sig.V - 27)

	pub, err := crypto.SigToPub(digest, raw)
	if err != nil {
		t.Fatalf("SigToPub: %v", err)
	}
	got := crypto.PubkeyToAddress(*pub)
	if got != want {
		t.Fatalf("recovered %s, want %s", got, want)
	}
}

// TestWithdrawRejectsBelowMinimum guards the HL minimum-withdrawal check.
func TestWithdrawRejectsBelowMinimum(t *testing.T) {
	key, _ := crypto.GenerateKey()
	c := NewHyperliquidClient(&TxExecutor{evmPrivateKey: key})
	err := c.Withdraw(1.0, crypto.PubkeyToAddress(key.PublicKey).Hex())
	if err == nil {
		t.Fatal("expected rejection for $1 withdrawal below HL minimum")
	}
}

// TestReverseRoute swaps origin and destination and flags the Solana source
// correctly, which the R4 return leg (BRETT->TRUMP) depends on.
func TestReverseRoute(t *testing.T) {
	r4, ok := R4Route()
	if !ok {
		t.Fatal("R4 route not found")
	}
	rev := ReverseRoute(r4)
	if rev.FromChain != r4.ToChain || rev.ToChain != r4.FromChain {
		t.Fatalf("chains not swapped: %s->%s", rev.FromChain, rev.ToChain)
	}
	if rev.FromToken != r4.ToToken || rev.ToToken != r4.FromToken {
		t.Fatalf("tokens not swapped")
	}
	// R4 forward is Solana->Base, so the return is Base->Solana: not Solana-sourced.
	if rev.IsSolanaSrc {
		t.Fatalf("return leg should not be Solana-sourced")
	}
	if getSourceTokenName(rev) != "BRETT" {
		t.Fatalf("return source token should be BRETT, got %s", getSourceTokenName(rev))
	}
}
