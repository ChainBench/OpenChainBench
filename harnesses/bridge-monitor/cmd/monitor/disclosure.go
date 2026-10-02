package main

import (
	"encoding/base64"
	"encoding/hex"
	"strings"

	"github.com/mr-tron/base58"
)

// Does the source transaction tell the source chain where the money is going?
//
// Aurora says swaps through Intents are confidential. That is a real property
// and this harness had no instrument for it, so the bench could neither
// support nor contest the claim. What follows is the narrowest honest version
// of the question, and the narrowness is the point.
//
// A lock-and-mint bridge encodes the destination in its deposit call: the
// recipient address and target chain are parameters, so anyone reading the
// source chain learns the other end immediately. An intent system sends a
// plain transfer to a one-time deposit address and settles separately, so the
// same reader learns nothing from that transaction alone.
//
// We do not need to fetch anything to measure this. The harness builds the
// transaction it is about to broadcast, so the exact bytes the source chain
// will record are in hand at execution time. The probe is a byte search for
// our own destination address in our own outgoing payload: uniform across all
// eight providers, with no per-provider calldata parsing, which is the trap
// that makes this kind of comparison lie.
//
// WHAT A NEGATIVE DOES NOT MEAN. "The destination is not in the source
// transaction" is not "the swap is confidential". A solver may publish the
// link elsewhere, amounts may correlate, timing may correlate, and a one-time
// deposit address can still be clustered. This measures one specific
// disclosure, the most direct one, and the bench must say so rather than let
// a reader hear the larger claim.

// destinationInPayload reports whether `dest` appears in the transaction
// payload the harness is about to broadcast.
//
// EVM payloads are hex calldata and an address appears as its 20 bytes, left
// padded to a word; searching the hex for the 40 characters finds it wherever
// it sits. Solana payloads are a base64 serialized message whose account keys
// are raw 32-byte public keys, so the base58 text never appears and the
// address has to be decoded before searching.
//
// An address we cannot decode returns false with ok=false: the caller must be
// able to tell "not disclosed" from "not measured", because publishing the
// first when we mean the second would be the whole failure this file exists
// to avoid.
func destinationInPayload(payload, dest string, solana bool) (found bool, ok bool) {
	dest = strings.TrimSpace(dest)
	if payload == "" || dest == "" {
		return false, false
	}
	if solana {
		key, err := base58.Decode(dest)
		if err != nil || len(key) == 0 {
			return false, false
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(payload))
		if err != nil || len(raw) == 0 {
			return false, false
		}
		return strings.Contains(string(raw), string(key)), true
	}

	hexDest := strings.ToLower(strings.TrimPrefix(dest, "0x"))
	if _, err := hex.DecodeString(hexDest); err != nil || len(hexDest) != 40 {
		return false, false
	}
	return strings.Contains(strings.ToLower(payload), hexDest), true
}

// recordDestinationDisclosure publishes the reading for one broadcast.
//
// Two reasons a route is not measurable, and both emit nothing rather than a
// zero. An address or payload we cannot decode is the obvious one. The other
// is subtler and would have published a flattering lie: when the source chain
// is Solana and the destination address is also the signing wallet, the
// serialized message carries that key as the fee payer whatever the bridge
// does, so every such route would read as disclosed on evidence that has
// nothing to do with the bridge. No route in the current triangle hits it,
// which is exactly why it needs a guard: the day someone adds a Solana to
// Solana leg, this must go quiet rather than start lying.
func recordDestinationDisclosure(bridge string, route TestRoute, payload, destination, sender, region string) {
	solanaSource := route.FromChain == "Solana"
	if solanaSource && strings.EqualFold(strings.TrimSpace(destination), strings.TrimSpace(sender)) {
		return
	}
	found, ok := destinationInPayload(payload, destination, solanaSource)
	if !ok {
		return
	}
	v := 0.0
	if found {
		v = 1
	}
	bridgeDestinationDisclosed.WithLabelValues(bridge, route.FromChain, route.ToChain, region).Set(v)
}
