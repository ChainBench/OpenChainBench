package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The id comes out of the event's data as ascii, exactly as it goes into the
// Solana memo. This is the join, so it is pinned against a real log's data.
func TestMobulaIDFromRealEventData(t *testing.T) {
	// Word 0 of a Robinhood fill, read on chain 2026-10-23.
	data := "0x323637373935382d303937376331322d35376400000000000000000000000000"
	if got := mobulaIDFromData(data); got != "2677958-0977c12-57d" {
		t.Fatalf("mobulaIDFromData = %q, want %q", got, "2677958-0977c12-57d")
	}
}

// A changed layout must STOP the join, not produce a key that pairs with
// something. The pump dust gate makes the same choice for the same reason: a
// decoder that guesses is worse than one that refuses.
func TestMobulaIDRefusesAnythingButAscii(t *testing.T) {
	for name, data := range map[string]string{
		"empty":           "",
		"short":           "0x3236373739",
		"all zero":        "0x" + strings.Repeat("00", 32),
		"high bytes":      "0x" + strings.Repeat("fe", 32),
		"too short ascii": "0x" + strings.Repeat("41", 4) + strings.Repeat("00", 28), // "AAAA", under the floor
		"not hex":         "0xzzzz" + strings.Repeat("00", 30),
	} {
		if got := mobulaIDFromData(data); got != "" {
			t.Fatalf("%s: mobulaIDFromData(%q) = %q, want \"\"", name, data, got)
		}
	}
}

// A fill CONSUMES its intent. Without that a log re-read after a cursor reset
// would be paired twice and the same settlement counted twice, which inflates
// the sample behind the published mean while looking like more data.
func TestAFillConsumesItsIntent(t *testing.T) {
	resetMobulaWindow()
	now := time.Now().Unix()
	mobulaNoteDeposit("abc-def-123", mobulaIntent{At: now, Amount: 10, App: "fomo-mobula"})

	if _, ok := mobulaTakeIntent("abc-def-123"); !ok {
		t.Fatal("the deposit just recorded was not found")
	}
	if _, ok := mobulaTakeIntent("abc-def-123"); ok {
		t.Fatal("the same intent paired twice; a re-read log would double-count")
	}
}

// Attribution is the fee payer AND the declaration. A sponsor whose product is
// not on the Mobula rail must not be attributed, or a new integrator's flow
// joins someone else's row under a product the bench cannot name.
func TestOnlyDeclaredAppsAreAttributedToTheMobulaRail(t *testing.T) {
	apps := mobulaApps()
	if len(apps) == 0 {
		t.Fatal("no sponsor maps to the mobula rail; the feed would never start")
	}
	declared := map[string]bool{}
	for _, p := range settleRails["mobula"] {
		declared[p] = true
	}
	for sponsor, product := range apps {
		if !declared[product] {
			t.Fatalf("sponsor %s maps to %q, which is not on the mobula rail", sponsor, product)
		}
		if _, ok := productNames[product]; !ok {
			t.Fatalf("sponsor %s maps to %q, which productNames cannot name", sponsor, product)
		}
	}
}

// The window survives a restart through REAL JSON, for the reason the pump
// window had to learn the hard way: four deploys in half an hour emptied it
// and the settlement column read blank each time.
func TestMobulaWindowSurvivesRealJSON(t *testing.T) {
	resetMobulaWindow()
	now := time.Now().Unix()
	mobulaNoteDeposit("keep-me-001", mobulaIntent{At: now - 30, Amount: 25.5, App: "fomo-mobula", User: "Sol111"})

	b, err := json.Marshal(&State{MobulaIntents: mobulaSaveIntents()})
	if err != nil {
		t.Fatal(err)
	}
	var back State
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	resetMobulaWindow()
	if n := mobulaLoadIntents(back.MobulaIntents, now); n != 1 {
		t.Fatalf("restored %d intents, want 1; serialised as %s", n, b)
	}
	got, ok := mobulaTakeIntent("keep-me-001")
	if !ok || got.Amount != 25.5 || got.App != "fomo-mobula" || got.User != "Sol111" {
		t.Fatalf("restored intent is %+v, ok=%v: the fields did not survive", got, ok)
	}
}

// And a long outage must not resurrect an intent whose fill landed while we
// were down: it would pair against whatever log arrived next.
func TestMobulaRestoreAppliesTheAgeRule(t *testing.T) {
	resetMobulaWindow()
	now := time.Now().Unix()
	in := map[string]mobulaIntent{
		"fresh-000-001": {At: now - 10, Amount: 5, App: "fomo-mobula"},
		"stale-000-002": {At: now - mobulaIntentAge - 1, Amount: 5, App: "fomo-mobula"},
		"noamount-0003": {At: now - 10, Amount: 0, App: "fomo-mobula"},
	}
	if n := mobulaLoadIntents(in, now); n != 1 {
		t.Fatalf("restored %d, want 1: only the fresh, valid intent qualifies", n)
	}
	if _, ok := mobulaTakeIntent("stale-000-002"); ok {
		t.Fatal("a stale intent came back and could pair with any later fill")
	}
}

func resetMobulaWindow() {
	mobulaWindow.Lock()
	mobulaWindow.by = nil
	mobulaWindow.Unlock()
}
