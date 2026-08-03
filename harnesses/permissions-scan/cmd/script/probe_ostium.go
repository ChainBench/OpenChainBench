package main

import (
	"fmt"
	"time"
)

// OstiumVault proxy on Arbitrum One.
// impl: 0x1E20E46C92F0786889462F065BC9DA163AF6020D (verified)
const ostiumVaultProxy = "0x20d419a8e12c45f88fda7c5760bb6923cee27f98"

func probeOstium(rpc string) {
	lastTs, err := ethCall(rpc, ostiumVaultProxy, selLastSettlementTs)
	if err != nil {
		fmt.Printf("[OSTIUM] lastSettlementTs error: %v\n", err)
		return
	}
	maxInterval, err := ethCall(rpc, ostiumVaultProxy, selMaxSettlementInterval)
	if err != nil {
		fmt.Printf("[OSTIUM] maxSettlementInterval error: %v\n", err)
		return
	}
	lastID, err := ethCall(rpc, ostiumVaultProxy, selLastSettlementId)
	if err != nil {
		fmt.Printf("[OSTIUM] lastSettlementId error: %v\n", err)
		return
	}

	now := time.Now().Unix()
	ageSecs := float64(now - lastTs.Int64())
	ageHours := ageSecs / 3600
	callable := 0.0
	if ageSecs >= float64(maxInterval.Int64()) {
		callable = 1.0
	}

	settlementAgeSecsGauge.WithLabelValues("ostium").Set(ageSecs)
	settlementAgeHrsGauge.WithLabelValues("ostium").Set(ageHours)
	settlementCallableGauge.WithLabelValues("ostium").Set(callable)
	lastSettlementIDGauge.WithLabelValues("ostium").Set(float64(lastID.Int64()))

	fmt.Printf("[OSTIUM] id=%d age=%.1fh (max=%dh) callable=%.0f\n",
		lastID.Int64(), ageHours, maxInterval.Int64()/3600, callable)
}
