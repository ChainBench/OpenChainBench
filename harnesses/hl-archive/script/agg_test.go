package script

import "testing"

func TestDayAggregator_UniqueUsers(t *testing.T) {
	a := NewDayAggregator("2026-05-31", "0xb")
	a.Add(Fill{User: "u1", Coin: "BTC", Px: 100, Sz: 1, BuilderFee: 0.1})
	a.Add(Fill{User: "u1", Coin: "BTC", Px: 100, Sz: 1, BuilderFee: 0.1})
	a.Add(Fill{User: "u2", Coin: "BTC", Px: 100, Sz: 1, BuilderFee: 0.1})
	rows := a.Rows()
	if len(rows) != 1 {
		t.Fatalf("got %d rows", len(rows))
	}
	if rows[0].FillCount != 3 {
		t.Fatalf("fill_count: %d", rows[0].FillCount)
	}
	if rows[0].UniqueUsers != 2 {
		t.Fatalf("unique_users: %d", rows[0].UniqueUsers)
	}
	if rows[0].VolumeUSD != 300 {
		t.Fatalf("volume: %v", rows[0].VolumeUSD)
	}
}

func TestBuilderActiveOn(t *testing.T) {
	b := Builder{ValidFrom: "2026-05-31"}
	if !builderActiveOn(b, mustDay("2026-06-01")) {
		t.Fatal("should be active on 06-01")
	}
	if builderActiveOn(b, mustDay("2026-05-30")) {
		t.Fatal("should not be active on 05-30")
	}
	if !builderActiveOn(Builder{}, mustDay("2024-01-01")) {
		t.Fatal("no valid_from means always active")
	}
}

func mustDay(s string) (t timeStub) { return parseDay(s) }
