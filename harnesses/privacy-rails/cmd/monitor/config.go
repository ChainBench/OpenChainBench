package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config carries only addresses and cadence. There is deliberately no API
// key field: every endpoint this harness touches answered keyless when it
// was measured on 2026-10-25, and if one starts demanding a credential the
// right outcome is a visible probe failure, not a silent key lookup.
type Config struct {
	MonitorRegion string
	TickInterval  time.Duration
	MetricsAddr   string

	MayaBase     string
	MayaMidgard  string
	OneClickBase string
	XmrListURL   string
	BasicSwapURL string

	// Destinations used for the delivery test. Both are checksum-verified
	// before use, in addresses.go, and the harness refuses to publish a
	// shielded verdict if the transparent control fails.
	ZecTransparent string
	ZecShielded    string
}

func envStr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func loadEnv() (*Config, error) {
	tick := 300
	if v := strings.TrimSpace(os.Getenv("TICK_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 60 {
			tick = n
		}
	}
	return &Config{
		MonitorRegion: envStr("MONITOR_REGION", "us-east"),
		// Overridable so a second harness can share a host, and so this one
		// can be smoke-tested on a laptop that already runs another probe.
		MetricsAddr:  envStr("METRICS_ADDR", ":2112"),
		TickInterval: time.Duration(tick) * time.Second,

		MayaBase:     envStr("MAYA_BASE", "https://mayanode.mayachain.info"),
		MayaMidgard:  envStr("MAYA_MIDGARD", "https://midgard.mayachain.info"),
		OneClickBase: envStr("ONECLICK_BASE", "https://1click.chaindefuser.com"),
		XmrListURL:   envStr("XMR_LIST_URL", "https://api.unstoppableswap.net/api/list"),
		// Not on basicswapdex.com: the book lives on a separate markets
		// host, which is why probing the project domain found nothing.
		BasicSwapURL: envStr("BASICSWAP_URL", "https://markets.basicswapdex.com/orderbook.json"),

		// Maya's own ZEC inbound address, handed over by its quote endpoint
		// and base58check-verified. Using an address the rail itself uses
		// avoids the trap that voided three earlier attempts at this test:
		// an invented address fails its checksum, the transparent control
		// fails with it, and the shielded refusal then proves nothing.
		ZecTransparent: envStr("ZEC_TRANSPARENT", "t1ZWB4EJsqUott6DEXQJW3LqoVvyimnpG8e"),
		// A mainnet unified address from zcash/zcash-test-vectors, bech32m
		// verified. Shielded addresses never appear on chain by design, so
		// a published test vector is the only sound source for one.
		ZecShielded: envStr("ZEC_SHIELDED", "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf"),
	}, nil
}
