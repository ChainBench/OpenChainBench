package main

import (
	"encoding/base64"
	"testing"

	"github.com/mr-tron/base58"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	// Real shapes, not placeholders: 20 bytes mixed case as a quote returns
	// it, and a 32-byte base58 key.
	evmDest = "0x5fC5360d040013D5cbA0D1dE2A9c7E6c4c16b83C"
	solDest = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

func TestEVMDestinationFoundWhenEncodedInCalldata(t *testing.T) {
	// A lock-and-mint deposit takes the recipient as a parameter, left padded
	// to a word. Anyone reading the source chain learns the other end.
	calldata := "0xa9059cbb" +
		"0000000000000000000000005fc5360d040013d5cba0d1de2a9c7e6c4c16b83c" +
		"00000000000000000000000000000000000000000000000000000000004c4b40"
	if found, ok := destinationInPayload(calldata, evmDest, payloadText); !ok || !found {
		t.Fatalf("recipient is a parameter of this call: found=%v ok=%v", found, ok)
	}
}

func TestEVMDestinationAbsentFromAPlainTransfer(t *testing.T) {
	// An intent system sends to a one-time deposit address and settles
	// separately: the destination is nowhere in what the source chain records.
	calldata := "0xa9059cbb" +
		"000000000000000000000000dEaD00000000000000000000000000000000BeEf" +
		"00000000000000000000000000000000000000000000000000000000004c4b40"
	found, ok := destinationInPayload(calldata, evmDest, payloadText)
	if !ok {
		t.Fatal("a well-formed address and payload must be measurable")
	}
	if found {
		t.Fatal("this calldata does not carry the destination")
	}
}

func TestEVMMatchIgnoresCase(t *testing.T) {
	calldata := "0x" + "0000000000000000000000005fc5360d040013d5cba0d1de2a9c7e6c4c16b83c"
	if found, ok := destinationInPayload(calldata, evmDest, payloadText); !ok || !found {
		t.Fatal("a checksummed address must match lower-case calldata")
	}
}

func TestSerializedSolanaSearchesDecodedKeyNotBase58Text(t *testing.T) {
	// A serialized message holds account keys as raw 32-byte values, so the
	// base58 string never appears in it. Searching for the text would report
	// every such route as undisclosed, which would be a flattering lie.
	key, err := base58.Decode(solDest)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	payload := base64.StdEncoding.EncodeToString(append([]byte("\x01\x00\x01"), key...))
	if found, ok := destinationInPayload(payload, solDest, payloadSerializedSolana); !ok || !found {
		t.Fatalf("the key is in this message: found=%v ok=%v", found, ok)
	}

	textPayload := base64.StdEncoding.EncodeToString([]byte(solDest))
	if found, _ := destinationInPayload(textPayload, solDest, payloadSerializedSolana); found {
		t.Fatal("matched the base58 text, which a real serialized message never contains")
	}
}

func TestRelayInstructionsCarryPubkeysAsText(t *testing.T) {
	// Relay's Solana path is the reason payloadKind exists. Its instruction
	// list is JSON whose pubkeys are base58 STRINGS, so it must be searched as
	// text. Reading it the way a serialized message is read finds nothing and
	// reports the route as undisclosed.
	ins := []RelaySolanaInstruction{{ProgramId: "11111111111111111111111111111111", Data: "0xdeadbeef"}}
	ins[0].Keys = append(ins[0].Keys, struct {
		Pubkey     string `json:"pubkey"`
		IsSigner   bool   `json:"isSigner"`
		IsWritable bool   `json:"isWritable"`
	}{Pubkey: solDest, IsSigner: false, IsWritable: true})

	payload := solanaInstructionsPayload(ins)
	if payload == "" {
		t.Fatal("instructions must render to searchable text")
	}
	if found, ok := destinationInPayload(payload, solDest, payloadText); !ok || !found {
		t.Fatalf("a pubkey in the instruction list is text and must be seen: found=%v ok=%v", found, ok)
	}
	// And the wrong kind must not quietly report "undisclosed".
	if found, _ := destinationInPayload(payload, solDest, payloadSerializedSolana); found {
		t.Fatal("JSON is not a base64 serialized message; this should not have matched")
	}
	if solanaInstructionsPayload(nil) != "" {
		t.Fatal("no instructions must render to nothing, not to an empty JSON array")
	}
}

func TestUnmeasurableIsNotTheSameAsUndisclosed(t *testing.T) {
	// The caller must tell "not disclosed" from "not measured". Publishing the
	// first when we mean the second is the failure this file exists to avoid.
	cases := []struct {
		name, payload, dest string
		kind                payloadKind
	}{
		{"empty payload", "", evmDest, payloadText},
		{"empty destination", "0xdeadbeef", "", payloadText},
		{"destination neither hex nor base58", "0xdeadbeef", "!!!not-an-address!!!", payloadText},
		{"evm address of the wrong length", "0xdeadbeef", "0x1234", payloadText},
		{"solana payload not base64", "!!!!", solDest, payloadSerializedSolana},
		{"solana destination not base58", "aGVsbG8=", "0OIl", payloadSerializedSolana},
	}
	for _, c := range cases {
		found, ok := destinationInPayload(c.payload, c.dest, c.kind)
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

func TestSelfRouteIsNotMeasured(t *testing.T) {
	// When the destination is the signing wallet, that key is in the wallet's
	// own transaction whatever the bridge does, so the reading would be about
	// us. No route in the current triangle hits this, which is exactly why it
	// needs a guard rather than a comment.
	key, err := base58.Decode(solDest)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	payload := base64.StdEncoding.EncodeToString(append([]byte("\x01\x00\x01"), key...))

	bridgeDestinationDisclosed.Reset()
	recordDestinationDisclosure("x", TestRoute{FromChain: "Solana", ToChain: "Solana"},
		payload, solDest, solDest, "eu-west", payloadSerializedSolana)
	if n := seriesHeld(); n != 0 {
		t.Fatalf("a self-route must publish nothing, got %d series", n)
	}

	recordDestinationDisclosure("x", TestRoute{FromChain: "Solana", ToChain: "Base"},
		payload, solDest, "someOtherWallet", "eu-west", payloadSerializedSolana)
	if n := seriesHeld(); n != 1 {
		t.Fatalf("a cross-chain leg must publish exactly one series, got %d", n)
	}
}

func TestUnreadablePayloadPublishesNothing(t *testing.T) {
	// A zero here reads as "this bridge does not disclose", which would be a
	// claim we have not earned.
	bridgeDestinationDisclosed.Reset()
	recordDestinationDisclosure("x", TestRoute{FromChain: "Base", ToChain: "Arbitrum"},
		"", evmDest, "0xsender", "eu-west", payloadText)
	if n := seriesHeld(); n != 0 {
		t.Fatalf("an unreadable payload must publish nothing, got %d series", n)
	}
}
