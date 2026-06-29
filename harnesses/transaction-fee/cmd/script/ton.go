package main

import (
	"time"
)

// TON native-transfer fee sampler.
//
// TON's fee model (storage + gas + forward + in_fwd) is non-trivial and
// no public API exposes a one-shot "estimate native transfer cost" call
// without submitting a real BoC. The typical observed cost of a vanilla
// wallet-v4 native TON transfer is ~5_000_000 nanoton (0.005 TON), which
// we hardcode here as the honest conservative estimate.
//
// If a real TON consumer use case emerges, swap this for tonapi
// `/v2/wallet/emulate` or LiteAPI `runGetMethod` over an emulated
// transfer. For now: deterministic single tier.
//
// 1 TON = 10^9 nanoton — main.go KindTon scales accordingly.

const tonTypicalTransferNanoton = 5_000_000.0

type tonFetcher struct {
	timeout time.Duration
}

func init() {
	registerFetcher(KindTon, &tonFetcher{timeout: 8 * time.Second})
}

func (f *tonFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	// Hardcoded honest value — see top-of-file comment for rationale.
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: tonTypicalTransferNanoton,
	}}, nil
}
