package main

import (
	"encoding/base64"
	"testing"

	"github.com/mr-tron/base58"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	// A real destination shape, not a placeholder: 20 bytes, mixed case, as a
	// quote hands it back.
	evmDest = "0x5fC5360d040013D5cbA0D1dE2A9c7E6c4c16b83C"
	solDest = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

func TestEVMDestinationFoundWhenEncodedInCalldata(t *testing.T) {
	// A lock-and-mint deposit takes the recipient as a parameter, left padded
	// to a word. Anyone reading the source chain learns the other end.
	calldata := "0xa9059cbb" +
		"0000000000000000000000005fc5360d040013d5cba0d1de2a9c7e6c4c16b83c" +
		"00000000000000000000000000000000000000000000000000000000004c4b40"
	found, ok := destinationInPayload(calldata, evmDest, false)
	if !ok || !found {
		t.Fatalf("recipient is a parameter of this call and must be seen: found=%v ok=%v", found, ok)
	}
}

func TestEVMDestinationAbsentFromAPlainTransfer(t *testing.T) {
	// An intent system sends to a one-time deposit address and settles
	// separately: the destination is nowhere in what the source chain records.
	calldata := "0xa9059cbb" +
		"000000000000000000000000dEaD00000000000000000000000000000000BeEf" +
		"00000000000000000000000000000000000000000000000000000000004c4b40"
	found, ok := destinationInPayload(calldata, evmDest, false)
	if !ok {
		t.Fatal("a well-formed address and payload must be measurable")
	}
	if found {
		t.Fatal("this calldata does not carry the destination")
	}
}

func TestEVMMatchIgnoresCase(t *testing.T) {
	// Quotes return checksummed addresses; calldata is lower case.
	calldata := "0x" + "0000000000000000000000005fc5360d040013d5cba0d1de2a9c7e6c4c16b83c"
	if found, ok := destinationInPayload(calldata, evmDest, false); !ok || !found {
		t.Fatal("a checksummed address must match lower-case calldata")
	}
}

func TestSolanaSearchesDecodedKeyNotBase58Text(t *testing.T) {
	// A serialized Solana message holds account keys as raw 32-byte values, so
	// the base58 string never appears in it. Searching for the text would
	// report every Solana route as confidential, which would be a flattering
	// lie rather than a measurement.
	key, err := base58.Decode(solDest)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	msg := append([]byte("\x01\x00\x01"), key...)
	payload := base64.StdEncoding.EncodeToString(msg)

	found, ok := destinationInPayload(payload, solDest, true)
	if !ok || !found {
		t.Fatalf("the key is in this message: found=%v ok=%v", found, ok)
	}

	// And the text form must not be what carries the match.
	textPayload := base64.StdEncoding.EncodeToString([]byte(solDest))
	if found, _ := destinationInPayload(textPayload, solDest, true); found {
		t.Fatal("matched the base58 text, which a real serialized message never contains")
	}
}

func TestUnmeasurableIsNotTheSameAsUndisclosed(t *testing.T) {
	// The caller must be able to tell "not disclosed" from "not measured".
	// Publishing the first when we mean the second is the failure this whole
	// file exists to avoid.
	cases := []struct {
		name, payload, dest string
		solana              bool
	}{
		{"empty payload", "", evmDest, false},
		{"empty destination", "0xdeadbeef", "", false},
		{"destination not an address", "0xdeadbeef", "not-an-address", false},
		{"evm address of the wrong length", "0xdeadbeef", "0x1234", false},
		{"solana payload not base64", "!!!!", solDest, true},
		{"solana destination not base58", "aGVsbG8=", "0OIl", true},
	}
	for _, c := range cases {
		found, ok := destinationInPayload(c.payload, c.dest, c.solana)
		if ok {
			t.Errorf("%s: should be unmeasurable, got ok=true", c.name)
		}
		if found {
			t.Errorf("%s: unmeasurable must never report a finding", c.name)
		}
	}
}

// seriesHeld reports how many series the disclosure gauge currently carries.
func seriesHeld() int {
	ch := make(chan prometheus.Metric, 64)
	bridgeDestinationDisclosed.Collect(ch)
	close(ch)
	n := 0
	for range ch {
		n++
	}
	return n
}

// The guard that stops a Solana leg reading as disclosed on evidence that has
// nothing to do with the bridge.
func TestSolanaSelfRouteIsNotMeasured(t *testing.T) {
	key, err := base58.Decode(solDest)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	payload := base64.StdEncoding.EncodeToString(append([]byte("\x01\x00\x01"), key...))

	// Source Solana and a destination equal to the signing wallet: that key
	// sits in the message as fee payer whatever the bridge does, so the
	// reading would be about us, not about the bridge.
	bridgeDestinationDisclosed.Reset()
	recordDestinationDisclosure("x", TestRoute{FromChain: "Solana", ToChain: "Solana"},
		payload, solDest, solDest, "eu-west")
	if n := seriesHeld(); n != 0 {
		t.Fatalf("a Solana self-route must publish nothing, got %d series", n)
	}

	// A real cross-chain leg from the same source does mean something.
	recordDestinationDisclosure("x", TestRoute{FromChain: "Solana", ToChain: "Base"},
		payload, solDest, "someOtherWallet", "eu-west")
	if n := seriesHeld(); n != 1 {
		t.Fatalf("a cross-chain leg must publish exactly one series, got %d", n)
	}
}

// An unreadable payload must stay silent rather than publish a zero: a zero
// here reads as "this bridge does not disclose", which would be a claim we
// have not earned.
func TestUnreadablePayloadPublishesNothing(t *testing.T) {
	bridgeDestinationDisclosed.Reset()
	recordDestinationDisclosure("x", TestRoute{FromChain: "Base", ToChain: "Arbitrum"},
		"", evmDest, "0xsender", "eu-west")
	if n := seriesHeld(); n != 0 {
		t.Fatalf("an unreadable payload must publish nothing, got %d series", n)
	}
}
