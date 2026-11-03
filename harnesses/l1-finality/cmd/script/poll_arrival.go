package main

import "time"

// pollArrival estimates when a polled chain's new head reached us.
//
// A poll that sees a new head only knows it landed between the previous
// answer and this one. Taking this answer's receive time would add, on
// average, half a poll interval to every sample; the midpoint of the two
// receive times removes that bias, and the error is bounded by half the
// gap. A gap wider than maxGap (a failed or slow poll in between) leaves
// the arrival too uncertain, and the sample is dropped.
type pollArrival struct {
	prevRecv time.Time
}

// observe records one successful answer received at recv. advanced says the
// answer carried a head we had not seen before. It returns the estimated
// arrival of that head, or ok=false when there is nothing to time.
func (p *pollArrival) observe(recv time.Time, advanced bool, maxGap time.Duration) (time.Time, bool) {
	prev := p.prevRecv
	p.prevRecv = recv
	if !advanced || prev.IsZero() {
		return time.Time{}, false
	}
	gap := recv.Sub(prev)
	if gap <= 0 || gap > maxGap {
		return time.Time{}, false
	}
	return prev.Add(gap / 2), true
}

// miss forgets the previous answer after a failed poll, so the next head
// is not timed across the hole.
func (p *pollArrival) miss() { p.prevRecv = time.Time{} }
