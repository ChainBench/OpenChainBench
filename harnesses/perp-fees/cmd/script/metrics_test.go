package main

import "testing"

func TestRecordSample_CEXPublishesNoFunding(t *testing.T) {
	recordSample(PerpSample{Venue: "funding-dex", Asset: "ETH", FundingRatePerHrBps: 1})
	recordSample(PerpSample{Venue: "funding-cex", Asset: "ETH", FundingUnmeasured: true})
	if !fundingGauge.DeleteLabelValues("funding-dex", "ETH") {
		t.Error("DEX funding not published")
	}
	if fundingGauge.DeleteLabelValues("funding-cex", "ETH") {
		t.Error("funding published for a venue that measures none")
	}
}

func TestRecordSample_ErrorKeepsOrDropsLastReading(t *testing.T) {
	tests := []struct {
		errType  string
		wantKept bool
	}{
		{errType: "server_error", wantKept: true},
		{errType: "timeout", wantKept: true},
		{errType: errTypeBadData, wantKept: false},
		{errType: errTypeNotFound, wantKept: false},
	}
	for _, tc := range tests {
		t.Run(tc.errType, func(t *testing.T) {
			venue := "err-" + tc.errType
			recordSample(PerpSample{Venue: venue, Asset: "ETH", AllInBps: 5})
			recordSample(PerpSample{Venue: venue, Asset: "ETH", Err: "x", ErrType: tc.errType})
			if kept := allInGauge.DeleteLabelValues(venue, "ETH"); kept != tc.wantKept {
				t.Errorf("all-in kept=%v, want %v", kept, tc.wantKept)
			}
		})
	}
}
