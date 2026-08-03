package main

import (
	"fmt"
	"time"
)

// gDAI vault proxy on Arbitrum One (primary probe target per bench methodology).
// gUSDC: 0xd3443ee1e91aF28e5FB858Fbd0D72A63bA8046E0 (backup)
const gainsgDAI = "0xd85E038593d7A098614721EaE955EC2022B9B91B"

func probeGains(rpc string) {
	epoch, err := ethCall(rpc, gainsgDAI, selCurrentEpoch)
	if err != nil {
		fmt.Printf("[GAINS] currentEpoch error: %v\n", err)
		return
	}
	epochStart, err := ethCall(rpc, gainsgDAI, selCurrentEpochStart)
	if err != nil {
		fmt.Printf("[GAINS] currentEpochStart error: %v\n", err)
		return
	}

	now := time.Now().Unix()
	ageHours := float64(now-epochStart.Int64()) / 3600

	epochNumberGauge.WithLabelValues("gains").Set(float64(epoch.Int64()))
	epochAgeHrsGauge.WithLabelValues("gains").Set(ageHours)

	fmt.Printf("[GAINS] epoch=%d age=%.1fh\n", epoch.Int64(), ageHours)
}
