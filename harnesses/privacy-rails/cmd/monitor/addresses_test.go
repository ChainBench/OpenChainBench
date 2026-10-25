package main

import "testing"

// The negative cases are not invented. Each one is an address string that was
// actually used against a live rail during this work and produced a refusal
// that was mistaken for a finding. Pinning them here is the point of the
// test: the guard exists because these three strings fooled three attempts.

func TestValidTransparentZec(t *testing.T) {
	// Maya's own ZEC inbound address, handed over by its quote endpoint.
	const real = "t1ZWB4EJsqUott6DEXQJW3LqoVvyimnpG8e"
	if !ValidTransparentZec(real) {
		t.Fatalf("a t-address the rail itself uses must verify")
	}

	bad := map[string]string{
		"invented, plausible shape": "t1KhGh5Y3CqPbVJhvnhVqRMNmF4TGgFbNnS",
		"last character flipped":    "t1ZWB4EJsqUott6DEXQJW3LqoVvyimnpG8f",
		"not a t-address":           "u1l8xunezsvhq8fgzfl7404m450nwnd76z",
		"empty":                     "",
	}
	for name, a := range bad {
		if ValidTransparentZec(a) {
			t.Errorf("%s: should not verify (%q)", name, a)
		}
	}
}

func TestValidShieldedZec(t *testing.T) {
	// A mainnet unified address from zcash/zcash-test-vectors, 141 chars.
	const real = "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf"
	if !ValidShieldedZec(real) {
		t.Fatalf("a published mainnet unified test vector must verify")
	}

	// THIS one is the reason the test exists. It was produced by taking the
	// truncated address out of a rail's error message and extending it by
	// hand, then sent to Maya, which answered "unable to parse address". That
	// answer was read as "Maya refuses shielded addresses" when it only meant
	// the string was mine.
	const fabricated = "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkyz6bth72g3f3pj0tzj4qkrr"
	if ValidShieldedZec(fabricated) {
		t.Errorf("the hand-extended address must fail its checksum")
	}

	bad := map[string]string{
		"testnet, not mainnet":   "utest1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7",
		"transparent, not u1":    "t1ZWB4EJsqUott6DEXQJW3LqoVvyimnpG8e",
		"character outside set":  "u1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"too short for checksum": "u11",
		"empty":                  "",
	}
	for name, a := range bad {
		if ValidShieldedZec(a) {
			t.Errorf("%s: should not verify (%q)", name, a)
		}
	}
}

// The delivery probe must be disabled, not silently wrong, when either
// address fails. A board built on a bad address would publish "no rail can
// pay shielded", which is the opposite of what was measured.
func TestVerifyDestinationsRefusesBadInput(t *testing.T) {
	good, err := loadEnv()
	if err != nil {
		t.Fatalf("loadEnv: %v", err)
	}
	if err := VerifyDestinations(good); err != nil {
		t.Fatalf("the shipped defaults must verify: %v", err)
	}

	broken := *good
	broken.ZecShielded = "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkyz6bth72g3f3pj0tzj4qkrr"
	if VerifyDestinations(&broken) == nil {
		t.Errorf("a fabricated shielded address must stop the probe")
	}

	broken2 := *good
	broken2.ZecTransparent = "t1KhGh5Y3CqPbVJhvnhVqRMNmF4TGgFbNnS"
	if VerifyDestinations(&broken2) == nil {
		t.Errorf("a fabricated transparent control must stop the probe")
	}
}

func TestRefusalReasonKeepsTheMechanism(t *testing.T) {
	cases := map[string]string{
		// The exact strings Maya and 1Click returned on 2026-10-25.
		"generated memo too long for source chain: =:z:u1l8xun":        "memo_too_long",
		"recipient is not valid":                                       "recipient_rejected",
		"bad destination address: unable to parse address: MAYAN":      "address_unparsed",
		"failed to simulate swap: fail to add outbound tx: not enough": "no_route",
		"":                              "unknown",
		"something new nobody has seen": "other",
	}
	for in, want := range cases {
		if got := refusalReason(in); got != want {
			t.Errorf("refusalReason(%q) = %q, want %q", in, got, want)
		}
	}
}
