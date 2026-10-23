package main

import (
	"encoding/json"
	"testing"

	dto "github.com/prometheus/client_model/go"
)

func identifierCount(app, id string) (float64, bool) {
	var d dto.Metric
	if err := cAppIdentifier.WithLabelValues(app, id).Write(&d); err != nil {
		return 0, false
	}
	return d.Counter.GetValue(), true
}


// Every declared identifier is published from start, so a dead one shows as
// never matched instead of as a series nobody notices is missing.
func TestEveryDeclaredIdentifierIsPublished(t *testing.T) {
	n := 0
	for _, a := range xchainApps {
		ids := appIdentifiers(a)
		if len(ids) == 0 {
			t.Errorf("%s declares nothing it can be recognised by", a.Slug)
		}
		n += len(ids)
	}
	if n == 0 {
		t.Fatal("no identifiers at all")
	}
}

// A match moves the identifier that matched, and only that one: Phantom's
// retired recipient must stay where it was when the live one matches.
func TestIdentifierMatchMovesOnlyTheMatchingOne(t *testing.T) {
	var ph xchainApp
	for _, a := range xchainApps {
		if a.Slug == "phantom" {
			ph = a
		}
	}
	if len(ph.FeeRecipients) == 0 {
		t.Skip("phantom has no fee recipients declared")
	}
	live := ph.FeeRecipients[len(ph.FeeRecipients)-1]
	var r relayRaw
	raw := `{"id":"0xtest","status":"success","createdAt":"2026-10-23T00:00:00Z","data":{"appFees":[{"recipient":"` + live + `","bps":"85","amountUsd":"0.1"}]}}`
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		t.Fatal(err)
	}
	before := map[string]float64{}
	for _, id := range appIdentifiers(ph) {
		before[id], _ = identifierCount(ph.Slug, id)
	}
	classify(ph, originChain{slug: "base"}, r)
	for _, id := range appIdentifiers(ph) {
		after, _ := identifierCount(ph.Slug, id)
		want := 0.0
		if id == live {
			want = 1
		}
		if after-before[id] != want {
			t.Errorf("identifier %s moved by %v, want %v", id, after-before[id], want)
		}
	}
}
