package main

import "fmt"

// noExit is the sentinel for venues with no permissionless exit path.
// Using a large finite value instead of +Inf so ranking bars render correctly
// in CountLeaderboard (Infinity / Infinity = NaN, which breaks bar widths).
const noExit = 999999.0

var staticHours = map[string]float64{
	"lighter":     336,    // 14-day Desert Mode from Ethereum priority queue (ZK self-exit)
	"ostium":      720,    // 3 × 30-day maxSettlementInterval (tryNewSettlement() public)
	"gains":       noExit, // oracle epochs required; no time-based override
	"gmx":         noExit, // keeper CONTROLLER role required; no user override
	"vertex":      noExit, // impl contracts unverified; slow-mode unconfirmed on-chain
	"hyperliquid": noExit, // 2/3 validator co-sign; bridge EOA-upgradeable, no timelock
	"aster":       noExit, // 2/3 internal validators; no escape hatch documented
}

func emitStatic() {
	for venue, hours := range staticHours {
		worstCaseHoursGauge.WithLabelValues(venue).Set(hours)
	}
	fmt.Println("[STATIC] perp_exit_worst_case_hours emitted for all 7 venues")
}
