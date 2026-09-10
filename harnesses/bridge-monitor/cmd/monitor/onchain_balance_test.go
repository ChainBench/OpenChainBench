package main

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// TestErc20BalanceNilClientNoPanic guards the nil-interface trap that crash-
// looped the VPS: with un-dialled EVM clients, erc20BalanceOf must return an
// error, never panic on CallContract.
func TestErc20BalanceNilClientNoPanic(t *testing.T) {
	tx := &TxExecutor{} // baseClient / arbitrumClient are nil
	for _, chain := range []string{"base", "arbitrum"} {
		if _, err := tx.erc20BalanceOf(chain, common.Address{}, common.Address{}); err == nil {
			t.Errorf("%s: expected error for nil client, got nil (would have panicked)", chain)
		}
	}
}
