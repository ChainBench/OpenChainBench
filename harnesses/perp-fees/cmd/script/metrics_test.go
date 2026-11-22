package main

import "testing"

func TestRecordSample_FundingOnlyWhereRead(t *testing.T) {
	read := PerpSample{Venue: "funding-test", Asset: "ETH", HasFunding: true}
	recordSample(read)
	if !fundingGauge.DeleteLabelValues("funding-test", "ETH") {
		t.Fatal("funding read but not published")
	}
	recordSample(read)
	recordSample(PerpSample{Venue: "funding-test", Asset: "ETH"})
	if fundingGauge.DeleteLabelValues("funding-test", "ETH") {
		t.Error("funding series kept for a sample that read no funding")
	}
}
