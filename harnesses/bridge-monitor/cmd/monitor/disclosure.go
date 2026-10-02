package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/mr-tron/base58"
)

// Does the source transaction tell the source chain where the money is going?
//
// Aurora says swaps through Intents are confidential. The bench could neither
// support nor contest that, because it had no instrument for it, and a
// property nobody measures is where a benchmark quietly stops being one.
//
// This measures the narrowest honest version, and the narrowness is the point.
// A lock-and-mint bridge takes the recipient as a parameter of its deposit
// call, so anyone reading the source chain learns the other end immediately.
// An intent system sends a plain transfer to a one-time deposit address and
// settles separately, so the same reader learns nothing from that transaction
// alone. That difference is real, it is what "confidential" means
// operationally at the source, and it can be read without trusting anyone's
// description of their own product.
//
// Nothing is fetched. The harness builds the transaction it is about to
// broadcast, so the exact bytes the source chain will record are already in
// hand.
//
// WHAT A NEGATIVE DOES NOT MEAN. "The destination is not in the source
// transaction" is not "the swap is confidential". A solver may publish the
// link elsewhere, amounts may correlate, timing may correlate, and a one-time
// deposit address can still be clustered. This reads one specific disclosure,
// the most direct one, and the metric is named for exactly that.

// How a call site hands us its payload. An explicit kind rather than an
// "isSolana" flag, because the axis that matters is the encoding, not the
// chain: Relay's Solana path passes a JSON instruction list whose pubkeys are
// base58 TEXT, while Mobula's and LI.FI's pass a base64 serialized message
// whose pubkeys are raw BYTES. Searching one the way you search the other
// finds nothing and reports every route as undisclosed, which would be a
// flattering lie rather than a measurement.
type payloadKind int

const (
	// Hex calldata, or JSON carrying hex and base58 fields. Addresses appear
	// as text.
	payloadText payloadKind = iota
	// Base64 of a serialized Solana message. Account keys are raw 32-byte
	// values and the base58 form never appears.
	payloadSerializedSolana
)

// destinationInPayload reports whether `dest` appears in the payload the
// harness is about to broadcast.
//
// An address or payload we cannot decode returns ok=false. The caller must be
// able to tell "not disclosed" from "not measured", because publishing the
// first when we mean the second is the whole failure this file exists to
// avoid.
func destinationInPayload(payload, dest string, kind payloadKind) (found bool, ok bool) {
	dest = strings.TrimSpace(dest)
	payload = strings.TrimSpace(payload)
	if payload == "" || dest == "" {
		return false, false
	}

	if kind == payloadSerializedSolana {
		key, err := base58.Decode(dest)
		if err != nil || len(key) == 0 {
			return false, false
		}
		raw, err := base64.StdEncoding.DecodeString(payload)
		if err != nil || len(raw) == 0 {
			return false, false
		}
		return strings.Contains(string(raw), string(key)), true
	}

	// Text payload. An EVM address appears as its 40 hex characters wherever
	// it sits in calldata; a Solana address appears as its base58 form in a
	// JSON field. Both are a case-insensitive substring search, but only one
	// of the two is a valid reading of any given address, so the shape of the
	// address decides which.
	hexDest := strings.ToLower(strings.TrimPrefix(dest, "0x"))
	if len(hexDest) == 40 {
		if _, err := hex.DecodeString(hexDest); err == nil {
			return strings.Contains(strings.ToLower(payload), hexDest), true
		}
	}
	if _, err := base58.Decode(dest); err == nil && len(dest) >= 32 {
		return strings.Contains(payload, dest), true
	}
	return false, false
}

// solanaInstructionsPayload renders Relay's instruction list as the text the
// search expects. Its pubkeys are already base58 strings and its data is hex,
// so the JSON form carries every address in a readable shape.
func solanaInstructionsPayload(instructions []RelaySolanaInstruction) string {
	if len(instructions) == 0 {
		return ""
	}
	b, err := json.Marshal(instructions)
	if err != nil {
		return ""
	}
	return string(b)
}

// recordDestinationDisclosure publishes the reading for one broadcast.
//
// Two silences, both deliberate. An address or payload we cannot decode
// publishes nothing, because a zero reads as "this bridge does not disclose"
// and that is a claim we would not have earned. And a source whose
// destination is also the signing wallet publishes nothing: the wallet's own
// key is in its own transaction whatever the bridge does, so the reading would
// be about us. No route in the current triangle hits the second case, which is
// exactly why it needs a guard rather than a comment.
func recordDestinationDisclosure(bridge string, route TestRoute, payload, destination, sender, region string, kind payloadKind) {
	if strings.EqualFold(strings.TrimSpace(destination), strings.TrimSpace(sender)) {
		return
	}
	found, ok := destinationInPayload(payload, destination, kind)
	if !ok {
		return
	}
	v := 0.0
	if found {
		v = 1
	}
	bridgeDestinationDisclosed.WithLabelValues(bridge, route.FromChain, route.ToChain, region).Set(v)
}
