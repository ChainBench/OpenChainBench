package main

import (
	"fmt"
	"math"
)

var staticHours = map[string]float64{
	"lighter":     336,         // 14-day Desert Mode from Ethereum priority queue (ZK self-exit)
	"ostium":      720,         // 3 × 30-day maxSettlementInterval (tryNewSettlement() public)
	"gains":       math.Inf(1), // oracle epochs required; no time-based override
	"gmx":         math.Inf(1), // keeper CONTROLLER role required; no user override
	"vertex":      math.Inf(1), // impl contracts unverified; slow-mode unconfirmed on-chain
	"hyperliquid": math.Inf(1), // 2/3 validator co-sign; bridge EOA-upgradeable, no timelock
	"aster":       math.Inf(1), // 2/3 internal validators; no escape hatch documented
}

func emitStatic() {
	for venue, hours := range staticHours {
		worstCaseHoursGauge.WithLabelValues(venue).Set(hours)
	}
	fmt.Println("[STATIC] perp_exit_worst_case_hours emitted for all 7 venues")
}
