package main

import "testing"

func TestPulseSourceKey(t *testing.T) {
	cases := map[string]string{
		"zora-v4":           "zora",
		"clanker-v5":        "clanker",
		"pumpfun":           "pumpfun",
		"meteora-dbc":       "meteora-dbc",
		"raydium-launchlab": "raydium-launchlab",
		"long-xyz":          "long-xyz",
		"x-v":               "x-v",
	}
	for in, want := range cases {
		if got := pulseSourceKey(in); got != want {
			t.Errorf("pulseSourceKey(%q) = %q, want %q", in, got, want)
		}
	}
	// The sources seen on Base and Robinhood on 2026-11-19 must all pass.
	for _, src := range []string{"zora-v4", "bankr-v4", "clanker-v4", "clanker-v5", "doppler-v4", "pons-v2", "long-xyz", "lift", "flywheel-v4", "fobo", "lunchfun-v4"} {
		if !pulseLaunchpadSources[pulseSourceKey(src)] {
			t.Errorf("%q is rejected by the allow-list", src)
		}
	}
}
