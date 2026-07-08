package main

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Bitcoin wall-clock measurement via HTTP polling of mempool.space.
//
// Bitcoin has probabilistic finality: no block is ever protocol-final,
// confidence grows with confirmation depth. We use the exchange deposit
// convention of 6 confirmations and measure it with our own clock, the
// same way the WS wall-clock chains are measured:
//
//   T1 = first poll where block N is the chain tip
//   T2 = first poll where tip - N >= 6 (block N has 6 confirmations)
//   lag = T2 - T1
//
// Own-clock is deliberate. Bitcoin block timestamps are miner-set and
// may skew by up to ~2h (consensus only requires timestamp > median of
// last 11 and < network time + 2h), so a timestamp-based estimator can
// be wildly wrong on individual samples. Our own clock matches how every
// other chain in this harness is measured (harness-observed wall clock).
//
// Baseline rule: on the first successful poll we only record the tip
// height as a baseline and never record a firstSeen for it. That block
// may have been sitting at the tip for minutes before we started, so
// timing it would fabricate a sample. The first publish can therefore
// only happen after a genuinely observed arrival -> 6-conf transition:
// roughly 7 block intervals (~70 min) after process start.
//
// If the poll interval skips heights (tip jumps by 2+, or a reorg
// replaces the tip), the skipped heights never get a firstSeen entry and
// never produce a sample. We only publish for blocks whose arrival at
// the tip we actually observed. No publish on fetch failure.
//
// Cadence: 30s. Bitcoin blocks land every ~10 min on average, so this is
// gentle on mempool.space (free, keyless) and the <=30s quantization is
// noise against a ~60 min measurement.

const (
	bitcoinConfirmations = 6
	bitcoinPollInterval  = 30 * time.Second
	bitcoinUserAgent     = "OpenChainBench-harness/1.0"
)

// StartBitcoinWallClock launches a goroutine that polls the mempool.space
// tip height every 30s and emits l1_finality_wallclock_lag_milliseconds
// when an observed block reaches 6 confirmations.
func StartBitcoinWallClock() {
	base := strings.TrimRight(getenvDefault("RPC_BITCOIN", "https://mempool.space/api"), "/")
	go func() {
		backoff := 2 * time.Second
		for {
			err := runBitcoinPoll(base)
			if err != nil {
				fmt.Printf("[L1][bitcoin] poll error: %v (retrying in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("bitcoin").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runBitcoinPoll(base string) error {
	client := &http.Client{Timeout: 10 * time.Second}

	// firstSeen[height] = our clock when that height was first observed
	// as the chain tip. Populated only after the baseline poll.
	firstSeen := map[int64]time.Time{}
	var lastTip int64 // 0 = baseline not taken yet

	tick := time.NewTicker(bitcoinPollInterval)
	defer tick.Stop()
	consecErrors := 0

	// Immediate first poll so the baseline is set at startup rather than
	// one full tick later.
	for ; ; <-tick.C {
		tip, err := bitcoinTipHeight(client, base)
		if err != nil {
			consecErrors++
			wallClockHealth.WithLabelValues("bitcoin").Set(0)
			if consecErrors >= 10 {
				return fmt.Errorf("too many errors: %w", err)
			}
			continue
		}
		consecErrors = 0
		wallClockHealth.WithLabelValues("bitcoin").Set(1)
		now := time.Now()

		if lastTip == 0 {
			// Baseline: this block was already at the tip when we
			// started, we did not observe its arrival. Do not time it.
			lastTip = tip
			fmt.Printf("[L1][bitcoin] baseline tip=%d (timing starts with the next block)\n", tip)
			continue
		}

		if tip > lastTip {
			// Only the current tip gets a firstSeen. If the tip jumped
			// more than one height between polls we did not observe the
			// intermediate blocks arriving, so they are never timed.
			firstSeen[tip] = now
			fmt.Printf("[L1][bitcoin] new tip=%d (tracking for %d confirmations)\n", tip, bitcoinConfirmations)
			lastTip = tip
		} else if tip < lastTip {
			// Reorg: the previous tip was orphaned. Heights above the
			// new tip were replaced; drop their timers so we never
			// publish a sample for a block that left the best chain.
			for h := range firstSeen {
				if h > tip {
					delete(firstSeen, h)
				}
			}
			fmt.Printf("[L1][bitcoin] reorg: tip regressed %d -> %d\n", lastTip, tip)
			lastTip = tip
		}

		for h, t1 := range firstSeen {
			if tip-h >= bitcoinConfirmations {
				lagMs := float64(now.Sub(t1).Milliseconds())
				if lagMs >= 0 {
					wallClockLagGauge.WithLabelValues("bitcoin").Set(lagMs)
					wallClockLagSum.WithLabelValues("bitcoin").Observe(lagMs)
					wallClockSampleCtr.WithLabelValues("bitcoin").Inc()
					fmt.Printf("[L1][bitcoin] block=%d reached %d confirmations, wall-clock-lag=%.0fms (%.1f min)\n",
						h, bitcoinConfirmations, lagMs, lagMs/60000)
				}
				delete(firstSeen, h)
			}
		}
	}
}

// bitcoinTipHeight calls GET /blocks/tip/height, a plain-text integer.
func bitcoinTipHeight(client *http.Client, base string) (int64, error) {
	req, err := http.NewRequest("GET", base+"/blocks/tip/height", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", bitcoinUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse_height: %v", err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("bad_height: %d", n)
	}
	return n, nil
}
