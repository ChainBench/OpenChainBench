package main

import (
	"strings"
	"testing"
)

// cohort is what compute walks, so this is the guard that decides whether the
// rows exist at all. The same guard in xchainRows is not enough: that is how
// six duplicated rows once survived a green suite.
func TestCohortDeclaresTheMobulaRows(t *testing.T) {
	want := map[string]bool{}
	for _, p := range settleRails["mobula"] {
		for chain := range mobulaBridge {
			want[p+"-"+chain] = false
		}
	}
	if len(want) == 0 {
		t.Fatal("no Mobula rows are expected, so the rail is not declared")
	}
	for _, c := range cohort() {
		if _, ok := want[c.Slug]; ok {
			want[c.Slug] = true
			if c.Name == "" || strings.HasPrefix(c.Name, "-") {
				t.Fatalf("%s has no readable name (%q), so the row prints its slug", c.Slug, c.Name)
			}
		}
	}
	for slug, found := range want {
		if !found {
			t.Fatalf("cohort does not declare %s, so compute never publishes it", slug)
		}
	}
}

// No slug may be declared twice, or one trade publishes in two rows. This is
// the generic form of the duplication that shipped before.
func TestCohortHasNoDuplicateSlug(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range cohort() {
		if seen[c.Slug] {
			t.Fatalf("cohort declares %s twice: its swaps would publish in two rows", c.Slug)
		}
		seen[c.Slug] = true
	}
}

// Every Mobula row's slug must resolve back to the product and chain it was
// built from, or the pooled row and the settlement series disagree about what
// the route is called.
func TestMobulaSlugsRoundTrip(t *testing.T) {
	for _, p := range settleRails["mobula"] {
		for chain := range mobulaBridge {
			slug := p + "-" + chain
			gotP, gotC := productOf(slug)
			if gotP != p || gotC != chain {
				t.Fatalf("productOf(%q) = (%q, %q), want (%q, %q)", slug, gotP, gotC, p, chain)
			}
		}
	}
}

// The sink rule on a receipt shaped like a real fill: the bridge pays a pool,
// the pool pays an executor, the executor pays the user, and a fee contract
// takes a cut of the user's token. Only the user is a dead end that counts.
func TestSinkRuleFindsTheUserNotTheExecutor(t *testing.T) {
	const (
		bridge   = "0xa834e70303322d86e5dae95ee47e9c6a073d9812"
		pool     = "0x1111111111111111111111111111111111111111"
		executor = "0x2222222222222222222222222222222222222222"
		user     = "0x3333333333333333333333333333333333333333"
		token    = "0x4444444444444444444444444444444444444444"
		usdc     = "0x5555555555555555555555555555555555555555"
	)
	logs := []evmLog{
		xfer(usdc, bridge, pool, 1000),
		xfer(token, pool, executor, 500),
		// The user is paid in TWO pieces, which is the normal multi-venue
		// shape and what broke the first version of the rule.
		xfer(token, executor, user, 300),
		xfer(token, executor, user, 190),
		// A fee contract takes a cut of the same token: a dead end, but a
		// declared one, so it must not make the receipt ambiguous.
		xfer(token, executor, robinhoodTokenFee, 10),
	}
	gotUser, gotTok, amt, ok := mobulaSink(logs)
	if !ok {
		t.Fatal("the rule found no single user on a receipt that has one")
	}
	if gotUser != user {
		t.Fatalf("user = %s, want %s (the executor sends, so it is not a dead end)", gotUser, user)
	}
	if gotTok != token {
		t.Fatalf("token = %s, want %s", gotTok, token)
	}
	if amt.Int64() != 490 {
		t.Fatalf("amount = %d, want 490: the two legs must be SUMMED, not maxed", amt.Int64())
	}
}

// Two undeclared dead ends must leave the fill unpriced rather than pick one.
// A rule that is mostly right selects the rest of the row by transaction
// shape, which is the defect behind #3193 and #3217.
func TestSinkRuleRefusesAnAmbiguousReceipt(t *testing.T) {
	const (
		pool  = "0x1111111111111111111111111111111111111111"
		token = "0x4444444444444444444444444444444444444444"
		one   = "0x6666666666666666666666666666666666666666"
		two   = "0x7777777777777777777777777777777777777777"
	)
	logs := []evmLog{
		xfer(token, pool, one, 100),
		xfer(token, pool, two, 100),
	}
	if _, _, _, ok := mobulaSink(logs); ok {
		t.Fatal("two dead ends resolved to a user; the fill must stay unpriced")
	}
}

// A token contract receiving its own token is taxing a transfer, not holding
// a position, so it must not be read as the user or make the receipt
// ambiguous.
func TestSinkRuleIgnoresATokenTaxingItself(t *testing.T) {
	const (
		pool  = "0x1111111111111111111111111111111111111111"
		user  = "0x3333333333333333333333333333333333333333"
		token = "0x4444444444444444444444444444444444444444"
	)
	logs := []evmLog{
		xfer(token, pool, user, 900),
		xfer(token, pool, token, 100),
	}
	got, _, amt, ok := mobulaSink(logs)
	if !ok || got != user {
		t.Fatalf("user = %s ok=%v, want %s: the token's own tax leg is not a holder", got, ok, user)
	}
	if amt.Int64() != 900 {
		t.Fatalf("amount = %d, want 900", amt.Int64())
	}
}

// xfer builds an ERC-20 Transfer log the way a node returns one.
func xfer(token, from, to string, amount int64) evmLog {
	pad := func(a string) string {
		return "0x000000000000000000000000" + strings.TrimPrefix(a, "0x")
	}
	data := "0x" + strings.Repeat("0", 64-len(big64(amount))) + big64(amount)
	return evmLog{
		Address: token,
		Topics:  []string{topicERC20Transfer, pad(from), pad(to)},
		Data:    data,
	}
}

func big64(v int64) string {
	const hexd = "0123456789abcdef"
	if v == 0 {
		return "0"
	}
	out := ""
	for v > 0 {
		out = string(hexd[v%16]) + out
		v /= 16
	}
	return out
}
