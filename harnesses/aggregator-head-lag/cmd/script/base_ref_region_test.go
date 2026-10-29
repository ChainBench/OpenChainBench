package main

import "testing"

// The Base reference counter is the instrument the staged rollout is run on:
// one region at a time, the others as controls. Without a region label every
// region's counts pile into one series and that comparison cannot be made,
// which is exactly what shipped first and had to be corrected within the hour.
//
// It also has to agree with the region on every other series from the same
// process, or two charts of the same probe disagree about where it runs.

func TestMonitorRegionLabelMirrorsTheConfig(t *testing.T) {
	t.Setenv("MONITOR_REGION", "eu-west")
	if got := monitorRegionLabel(); got != "eu-west" {
		t.Fatalf("got %q want eu-west", got)
	}
}

func TestMonitorRegionLabelTrimsLikeTheConfig(t *testing.T) {
	// loadConfig trims, so this must too or the same probe would publish
	// region="eu-west" on one metric and region=" eu-west" on another.
	t.Setenv("MONITOR_REGION", "  sgp  ")
	if got := monitorRegionLabel(); got != "sgp" {
		t.Fatalf("got %q want sgp", got)
	}
}

func TestMonitorRegionLabelDefaultsToUnknown(t *testing.T) {
	// Same default as loadConfig. An empty label would make the series
	// silently merge with any other region whose variable is also unset.
	t.Setenv("MONITOR_REGION", "")
	if got := monitorRegionLabel(); got != "unknown" {
		t.Fatalf("got %q want unknown", got)
	}
}
