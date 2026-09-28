package main

import "testing"

// The HLP vault fallback sees backstop liquidations only, a knowably partial
// numerator. Without the 0xArchive key the venue has no liquidation source
// and the row reads N/A, the same rule Lighter and Aster follow.
func TestHyperliquid_NoKeyMeansNoLiquidationSource(t *testing.T) {
	if (&Hyperliquid{}).HasLiquidationSource() {
		t.Fatal("HasLiquidationSource must be false without OXARCHIVE_API_KEY")
	}
	if !(&Hyperliquid{archiveAPIKey: "k"}).HasLiquidationSource() {
		t.Fatal("HasLiquidationSource must be true with a key")
	}
}
