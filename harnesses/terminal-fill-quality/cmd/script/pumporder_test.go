package main

import (
	"strings"
	"testing"
)

// The payout body, from a real instruction read on 2026-10-23. Keeping the
// bytes verbatim is the point: every offset in the decoder is a claim about
// this layout, and a hand-built fixture would only test the decoder against
// itself.
//
//	SOL 5vJPiReAUgfWVEB72tRRDBMNmZjutga2WPxBbkV1sSQwXxLXcRPHTFSQETiE6mLqq8ficerPKikBwNkyVbq7pnGR
//	EVM 0x510d9a64b3f53de3bc6104dcc053a810efdb2f353d39746f7edcd84eb5408f3f
//
// The EVM sell event says the router received 0.149648 of the stable and the
// payout says 0.135031 was delivered. Both numbers are in this test because
// the pair is the measurement: 0.135031 was also confirmed independently from
// the user's own USDC balance change across the transaction.
const pumpPayoutFixture = "e445a52e51cb9a1d" + // CPI discriminator
	"f5184562bce7031b" + // payout event discriminator
	"43d9e4bfc5666483d5de06cf2cb09b58a9fe5f118bb186cc267ae5d644497931" + // pool
	"07490b9a970e478db4997d8c62569d701cd076c2077746552410c55a8d5b3227" + // user
	"770f020000000000" + // amount, u64 LE = 135031
	"76bd3fc7ec124eb6a4ec9dfb1e0a82bb" + // order id
	"5a3e427cad000000" // trailing field this decoder does not read

func TestDecodePumpPayoutReadsTheDeliveredAmountAndOrder(t *testing.T) {
	p, err := decodePumpPayout(mustHex(t, pumpPayoutFixture))
	if err != nil {
		t.Fatalf("decodePumpPayout: %v", err)
	}
	if p.Amount != 135031 {
		t.Errorf("Amount = %d, want 135031 (0.135031, the figure the user's own "+
			"USDC balance change confirms)", p.Amount)
	}
	if p.Order != "76bd3fc7ec124eb6a4ec9dfb1e0a82bb" {
		t.Errorf("Order = %q, want 76bd3fc7ec124eb6a4ec9dfb1e0a82bb", p.Order)
	}
	if p.User == "" || strings.HasPrefix(p.User, "0") && len(p.User) < 32 {
		t.Errorf("User = %q, want a base58 pubkey", p.User)
	}
}

// The two events ride the same CPI discriminator and name the same pool, and
// their bodies put the amount and the order id at SWAPPED offsets. So each
// decoder must refuse the other's event: accepting it would publish an order
// id's first eight bytes as an amount, which is a number in the quintillions
// and would survive every plausibility check that only looks for "not zero".
func TestPumpDecodersRefuseEachOthersEvents(t *testing.T) {
	payout := mustHex(t, pumpPayoutFixture)
	if _, err := decodePumpDeposit(payout); err == nil {
		t.Fatal("decodePumpDeposit accepted a PAYOUT event; the deposit's amount " +
			"offset lands inside the payout's order id")
	}
	// A deposit body: same pool, deposit discriminator, amount at [80:88].
	deposit := mustHex(t, "e445a52e51cb9a1d"+"1f8cc689c670de87"+
		"43d9e4bfc5666483d5de06cf2cb09b58a9fe5f118bb186cc267ae5d644497931"+
		"07490b9a970e478db4997d8c62569d701cd076c2077746552410c55a8d5b3227"+
		"aabbccddeeff00112233445566778899"+ // order id at [64:80]
		"8038010000000000"+ // amount at [80:88] = 80000 (0x13880, little endian)
		"deadbeef")
	if _, err := decodePumpPayout(deposit); err == nil {
		t.Fatal("decodePumpPayout accepted a DEPOSIT event")
	}
	d, err := decodePumpDeposit(deposit)
	if err != nil {
		t.Fatalf("decodePumpDeposit on its own event: %v", err)
	}
	if d.Amount != 80000 {
		t.Errorf("deposit Amount = %d, want 80000", d.Amount)
	}
	// The sixteen bytes this file used to call "bytes that vary" are the order
	// id, and the deposit now carries it so the buy direction can be joined
	// the same way once its match rate says it can.
	if d.Order != "aabbccddeeff00112233445566778899" {
		t.Errorf("deposit Order = %q, want the id at body[64:80]", d.Order)
	}
}

// An all-zero id would join every leg whose own id failed to decode, so it is
// refused rather than stored.
func TestDecodePumpPayoutRefusesAZeroOrder(t *testing.T) {
	zeroed := strings.Replace(pumpPayoutFixture,
		"76bd3fc7ec124eb6a4ec9dfb1e0a82bb", strings.Repeat("0", 32), 1)
	if _, err := decodePumpPayout(mustHex(t, zeroed)); err == nil {
		t.Fatal("a payout with an all-zero order id was accepted")
	}
}

// The id sits LEFT-aligned in topic1, which is why pumpOrderOf takes the first
// sixteen bytes. Read from the other end every id would be zero, every lookup
// would miss, and the join would look absent rather than misread.
func TestPumpOrderOfReadsTopic1LeftAligned(t *testing.T) {
	const router = "0x5399d94d2cab7c252a6034042e1917a0e5e17a18"
	logs := []evmLog{{
		Address: router,
		Topics: []string{topicPumpSell,
			"0x7d5ba52289754191ad9c0e624f1573fe" + strings.Repeat("0", 32),
			"0x000000000000000000000000713ebdafaee11646260f0180d1d6c9c892a87f4e"},
	}}
	order, side := pumpOrderOf(logs, []string{router})
	if order != "7d5ba52289754191ad9c0e624f1573fe" {
		t.Errorf("order = %q, want the FIRST sixteen bytes of topic1", order)
	}
	if side != "sell" {
		t.Errorf("side = %q, want sell", side)
	}
}

// One generic router serves five chains and Robinhood has its own, so an event
// from a router this row does not read must not answer for it.
func TestPumpOrderOfIgnoresAnotherRoutersEvent(t *testing.T) {
	logs := []evmLog{{
		Address: "0x836b336fca26913176efc45a5a6e5e72cd7bd13b",
		Topics: []string{topicPumpSell,
			"0x7d5ba52289754191ad9c0e624f1573fe" + strings.Repeat("0", 32),
			"0x000000000000000000000000713ebdafaee11646260f0180d1d6c9c892a87f4e"},
	}}
	if order, side := pumpOrderOf(logs, []string{"0x5399d94d2cab7c252a6034042e1917a0e5e17a18"}); order != "" || side != "" {
		t.Errorf("read %q/%q from another router's event", order, side)
	}
}

// The window answers exactly once or not at all. That is the whole difference
// from the amount pairing it replaces, which had an ambiguous case, a maxLag to
// argue about, and a long tail that grew when the window widened.
func TestPumpPayoutWindowJoinsOnTheIdAndMissesCleanly(t *testing.T) {
	pumpPayoutWindow.Lock()
	pumpPayoutWindow.by = nil
	pumpPayoutWindow.Unlock()

	pumpNotePayout(1_700_000_000, "7d5ba52289754191ad9c0e624f1573fe", 0.135031, "Abc")
	pumpNotePayout(1_700_000_010, "28bc61f0c47c4f0b85c2bfe87a771423", 2766.074098, "Def")

	got, ok := pumpFindPayout("7d5ba52289754191ad9c0e624f1573fe")
	if !ok || got.amount != 0.135031 {
		t.Fatalf("joined = %v/%v, want 0.135031", got.amount, ok)
	}
	if _, ok := pumpFindPayout("ffffffffffffffffffffffffffffffff"); ok {
		t.Error("an id we never saw returned a delivery")
	}
	if _, ok := pumpFindPayout(""); ok {
		t.Error("an empty id returned a delivery; that is the no_id case and it " +
			"must not resolve to whatever was stored last")
	}
}

// A payout with no amount or no time is not a measurement and must not enter
// the window: a zero would price a sale as a total loss.
func TestPumpNotePayoutRefusesIncompleteDeliveries(t *testing.T) {
	pumpPayoutWindow.Lock()
	pumpPayoutWindow.by = nil
	pumpPayoutWindow.Unlock()

	pumpNotePayout(0, "aa", 1, "x")
	pumpNotePayout(1_700_000_000, "bb", 0, "x")
	pumpNotePayout(1_700_000_000, "", 1, "x")
	pumpPayoutWindow.Lock()
	n := len(pumpPayoutWindow.by)
	pumpPayoutWindow.Unlock()
	if n != 0 {
		t.Fatalf("%d incomplete payouts stored, want 0", n)
	}
}
