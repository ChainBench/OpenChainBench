package main

import "testing"

// Two rails must never land in one settlement series.
//
// Settlement is the rail's property, not the app's, and tfq_settle_ms is keyed
// by product. So if one product appeared on two rails, its figure would be the
// mean of two different bridges weighted by whatever mix of them that app
// happened to send, which is the composition error this bench has now hit
// three times: the chain mean of medians, a route's trade and funding legs,
// and here.
//
// The live trap this guards is FOMO. It rides Relay AND Mobula, so the Mobula
// rows have to be their own product (fomo-mobula) rather than more rows under
// fomo. Folding them in would be a one-word change nobody would notice,
// because the series would keep publishing a plausible number.
func TestRailsCannotPool(t *testing.T) {
	seen := map[string]string{}
	for rail, products := range settleRails {
		for _, p := range products {
			if other, dup := seen[p]; dup {
				t.Fatalf("product %q is on both the %q and %q rails: its settlement series would pool two bridges",
					p, other, rail)
			}
			seen[p] = rail
		}
	}
	if len(seen) < 4 {
		t.Fatalf("only %d routes declared; the map is meant to list every cross-chain route", len(seen))
	}
}

// Every declared route must be a product the bench can actually name, or its
// settlement publishes under a label no panel can render, which is how
// lane="bridge" hid 180,682 trades.
func TestEveryRailedRouteIsANamedProduct(t *testing.T) {
	for rail, products := range settleRails {
		for _, p := range products {
			if _, ok := productNames[p]; !ok {
				t.Fatalf("%q on the %q rail is not in productNames, so its row would be published under a bare slug",
					p, rail)
			}
		}
	}
}

// railOf answers for the routes that have a rail and stays silent for the
// ones that do not. A product with no cross-chain route must return "", not
// a default rail, since claiming Axiom settles over Relay would be inventing
// a route out of a map lookup.
func TestRailOfDoesNotInventARoute(t *testing.T) {
	for product, want := range map[string]string{
		"fomo":        "relay",
		"fomo-mobula": "mobula",
		"pump-bridge": "pump-bridge",
		"pump-fun":    "relay",
		"basedbot":    "relay",
		"axiom":       "",
		"gmgn":        "",
		"":            "",
	} {
		if got := railOf(product); got != want {
			t.Fatalf("railOf(%q) = %q, want %q", product, got, want)
		}
	}
}

// The Mobula join rests on two constants read off chain. Pinning their shape
// here is not a tautology: a topic that is not 32 bytes or a program id of the
// wrong length would fail silently at runtime as "no fills found", which reads
// exactly like a quiet bridge.
func TestMobulaJoinConstantsAreWellFormed(t *testing.T) {
	if len(mobulaFillTopic) != 66 || mobulaFillTopic[:2] != "0x" {
		t.Fatalf("mobulaFillTopic %q is not a 32-byte topic", mobulaFillTopic)
	}
	if n := len(mobulaMemoProgram); n < 32 || n > 44 {
		t.Fatalf("mobulaMemoProgram %q is not a base58 program id (%d chars)", mobulaMemoProgram, n)
	}
	// The bridge must be declared for every chain the measured flow reached:
	// Robinhood carried 79% of it, so an absent entry there would drop most
	// of the route while the row still published a figure from the rest.
	for _, c := range []string{"robinhood", "base", "bnb", "ethereum"} {
		if mobulaBridge[c] == "" {
			t.Fatalf("no Mobula bridge address for %q, a chain the measured flow reached", c)
		}
	}
}
