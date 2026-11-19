package main

import (
	"sync"
	"time"
)

// fairQueue holds one bounded FIFO per chain and hands tokens out round
// robin across chains.
//
// It replaced a single 500-slot channel on 2026-11-19. The workers check
// about 16 tokens a minute, and Pulse sends about 45, 36 of them Solana.
// The shared channel stayed full: Base and Robinhood got roughly one slot
// in fifteen, and a token waited about half an hour before its check, not
// the 30 s the methodology states.
//
// Round robin gives every chain a turn, so the quiet chains get checked on
// every token they produce, and Solana takes what is left. When a chain's
// queue is full the OLDEST token goes, so what gets checked is the freshest
// backlog. Throughput is unchanged, so provider call volume is unchanged.
type fairQueue struct {
	mu     sync.Mutex
	cap    int
	order  []string
	q      map[string][]TokenToCheck
	next   int
	notify chan struct{}
	drops  map[string]int
}

func newFairQueue(perChainCap int) *fairQueue {
	return &fairQueue{
		cap:    perChainCap,
		q:      map[string][]TokenToCheck{},
		notify: make(chan struct{}, 1),
		drops:  map[string]int{},
	}
}

// push queues a token. It returns true when an older token of the same
// chain was dropped to make room.
func (f *fairQueue) push(t TokenToCheck) bool {
	f.mu.Lock()
	c := t.ChainID
	if _, ok := f.q[c]; !ok {
		f.order = append(f.order, c)
	}
	dropped := false
	if len(f.q[c]) >= f.cap {
		f.q[c] = f.q[c][1:]
		f.drops[c]++
		dropped = true
	}
	f.q[c] = append(f.q[c], t)
	f.mu.Unlock()
	select {
	case f.notify <- struct{}{}:
	default:
	}
	return dropped
}

// tryPop takes the next token in round-robin order, if any.
func (f *fairQueue) tryPop() (TokenToCheck, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := len(f.order)
	for i := 0; i < n; i++ {
		idx := (f.next + i) % n
		c := f.order[idx]
		if len(f.q[c]) > 0 {
			t := f.q[c][0]
			f.q[c] = f.q[c][1:]
			f.next = (idx + 1) % n
			return t, true
		}
	}
	return TokenToCheck{}, false
}

// pop blocks until a token is available or stop closes.
func (f *fairQueue) pop(stop <-chan struct{}) (TokenToCheck, bool) {
	for {
		if t, ok := f.tryPop(); ok {
			return t, true
		}
		select {
		case <-stop:
			return TokenToCheck{}, false
		case <-f.notify:
		case <-time.After(time.Second):
		}
	}
}

// lengths reports each chain's queue depth and drop count, for the stats line.
func (f *fairQueue) lengths() (map[string]int, map[string]int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	l, d := map[string]int{}, map[string]int{}
	for c, q := range f.q {
		l[c] = len(q)
	}
	for c, n := range f.drops {
		d[c] = n
	}
	return l, d
}
