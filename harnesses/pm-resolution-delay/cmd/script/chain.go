package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/sha3"
)

// Event topics, verified live on Polygon 2026-06-12 (keccak256 of the
// canonical signatures, cross-checked against logs emitted by the adapters
// and the Optimistic Oracle in the last 24h).
const (
	// UmaCtfAdapter: QuestionInitialized(bytes32 indexed questionID, uint256
	// indexed requestTimestamp, address indexed creator, bytes ancillaryData,
	// address rewardToken, uint256 reward, uint256 proposalBond)
	topicQuestionInitialized = "0xeee0897acd6893adcaf2ba5158191b3601098ab6bece35c5d57874340b64c5b7"
	// QuestionResolved(bytes32 indexed questionID, int256 indexed
	// settledPrice, uint256[] payouts)
	topicQuestionResolved = "0x566c3fbdd12dd86bb341787f6d531f79fd7ad4ce7e3ae2d15ac0ca1b601af9df"
	// QuestionReset(bytes32 indexed questionID) — emitted when a dispute
	// resets the question for a fresh OO request.
	topicQuestionReset = "0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f"

	// OptimisticOracleV2-shaped events on the oracle the adapters use.
	// ProposePrice(address indexed requester, address indexed proposer,
	// bytes32 identifier, uint256 timestamp, bytes ancillaryData, int256
	// proposedPrice, uint256 expirationTimestamp, address currency)
	topicProposePrice = "0x6e51dd00371aabffa82cd401592f76ed51e98a9ea4b58751c70463a2c78b5ca1"
	// DisputePrice(address indexed requester, address indexed proposer,
	// address indexed disputer, bytes32 identifier, uint256 timestamp,
	// bytes ancillaryData, int256 proposedPrice)
	topicDisputePrice = "0x5165909c3d1c01c5d1e121ac6f6d01dda1ba24bc9e1f975b5a375339c15be7f3"
)

// question tracks one UMA questionID from first sighting to resolution.
// The join key across adapter and oracle is questionID =
// keccak256(ancillaryData), verified live against QuestionInitialized logs.
type question struct {
	title           string // extracted from ancillary "q: title: ..." for keyword classification
	firstSeen       int64
	firstProposedAt int64
	disputed        bool
	firstDisputedAt int64
}

type engine struct {
	rpc   *rpcClient
	gamma *gammaStore

	mu        sync.Mutex
	questions map[string]*question
}

func newEngine(rpc *rpcClient, gamma *gammaStore) *engine {
	return &engine{rpc: rpc, gamma: gamma, questions: map[string]*question{}}
}

func (e *engine) run(ctx context.Context) {
	head, err := e.waitHead(ctx)
	if err != nil {
		return // ctx cancelled
	}
	startTs := time.Now().Add(-time.Duration(backfillHours) * time.Hour).Unix()
	startBlock, err := e.rpc.blockAtTime(ctx, startTs, head)
	if err != nil {
		log.Printf("[chain] block-at-time search failed: %v (falling back to head-%d)", err, backfillHours*1700)
		approx := uint64(backfillHours) * 1700 // ~2.1s blocks
		if approx >= head {
			approx = head - 1
		}
		startBlock = head - approx
	}
	log.Printf("[chain] backfill %d -> %d (~%dh, chunk=%d)", startBlock, head, backfillHours, chunkBlocks)
	e.processRange(ctx, startBlock, head)
	log.Printf("[chain] backfill done, %d open questions in memory", e.openQuestions())

	last := head
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	cleanupTicker := time.NewTicker(time.Hour)
	defer cleanupTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-cleanupTicker.C:
			e.evictStale()
		case <-ticker.C:
			head, err := e.rpc.blockNumber(ctx)
			if err != nil {
				log.Printf("[chain] head poll failed: %v", err)
				continue
			}
			if head <= last {
				continue
			}
			e.processRange(ctx, last+1, head)
			last = head
		}
	}
}

func (e *engine) waitHead(ctx context.Context) (uint64, error) {
	for {
		head, err := e.rpc.blockNumber(ctx)
		if err == nil {
			return head, nil
		}
		log.Printf("[chain] cannot fetch head: %v (retry in 30s)", err)
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(30 * time.Second):
		}
	}
}

// processRange walks [from, to] in free-RPC-friendly chunks. A failed chunk
// is logged and skipped (next restart's 7-day backfill re-covers it); a
// successful chunk refreshes the listener-health timestamp.
func (e *engine) processRange(ctx context.Context, from, to uint64) {
	paddedAdapters := make([]string, len(adapterAddresses))
	for i, a := range adapterAddresses {
		paddedAdapters[i] = "0x" + strings.Repeat("0", 24) + strings.TrimPrefix(a, "0x")
	}
	for start := from; start <= to && ctx.Err() == nil; start += uint64(chunkBlocks) {
		end := start + uint64(chunkBlocks) - 1
		if end > to {
			end = to
		}
		adapterLogs, err1 := e.rpc.getLogs(ctx, start, end, adapterAddresses,
			[]any{[]string{topicQuestionInitialized, topicQuestionResolved, topicQuestionReset}})
		ooLogs, err2 := e.rpc.getLogs(ctx, start, end, ooAddresses,
			[]any{[]string{topicProposePrice, topicDisputePrice}, paddedAdapters})
		if err1 != nil || err2 != nil {
			log.Printf("[chain] chunk %d-%d failed (adapter=%v oo=%v), skipping", start, end, err1, err2)
			continue
		}
		tsAt, err := e.interpolator(ctx, start, end)
		if err != nil {
			log.Printf("[chain] chunk %d-%d timestamp anchors failed: %v, skipping", start, end, err)
			continue
		}
		logs := append(ooLogs, adapterLogs...)
		sort.SliceStable(logs, func(i, j int) bool {
			bi, _ := parseHexUint(logs[i].BlockNumber)
			bj, _ := parseHexUint(logs[j].BlockNumber)
			return bi < bj
		})
		for _, l := range logs {
			e.handleLog(l, tsAt)
		}
		lastPollOK.Store(time.Now().Unix())
		if end-start > 100 { // only log chunk progress during backfill
			log.Printf("[chain] chunk %d-%d: %d adapter logs, %d oo logs", start, end, len(adapterLogs), len(ooLogs))
		}
	}
}

// interpolator returns a blockNumber -> unix-timestamp function backed by the
// exact timestamps of the chunk boundaries with linear interpolation inside.
// Polygon's ~2.1s cadence keeps the error well under a minute per 2000-block
// chunk, far below the smallest histogram bucket (300s), while costing only
// two eth_getBlockByNumber calls per chunk.
func (e *engine) interpolator(ctx context.Context, from, to uint64) (func(uint64) int64, error) {
	tsFrom, err := e.rpc.blockTimestamp(ctx, from)
	if err != nil {
		return nil, err
	}
	if from == to {
		return func(uint64) int64 { return tsFrom }, nil
	}
	tsTo, err := e.rpc.blockTimestamp(ctx, to)
	if err != nil {
		return nil, err
	}
	span := float64(to - from)
	return func(b uint64) int64 {
		if b <= from {
			return tsFrom
		}
		if b >= to {
			return tsTo
		}
		return tsFrom + int64(float64(tsTo-tsFrom)*float64(b-from)/span)
	}, nil
}

func (e *engine) handleLog(l rpcLog, tsAt func(uint64) int64) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[chain] panic handling log tx=%s: %v (skipped)", l.TxHash, r)
		}
	}()
	if l.Removed || len(l.Topics) == 0 {
		return
	}
	blk, err := parseHexUint(l.BlockNumber)
	if err != nil {
		log.Printf("[chain] malformed blockNumber %q, skipping", l.BlockNumber)
		return
	}
	ts := tsAt(blk)

	switch l.Topics[0] {
	case topicQuestionInitialized:
		if len(l.Topics) < 2 {
			return
		}
		e.ensure(strings.ToLower(l.Topics[1]), ts)
	case topicProposePrice:
		anc, err := parseAncillary(l.Data, 2)
		if err != nil {
			log.Printf("[chain] bad ProposePrice data tx=%s: %v", l.TxHash, err)
			return
		}
		qid := keccakHex(anc)
		q := e.ensure(qid, ts)
		e.mu.Lock()
		if q.firstProposedAt == 0 {
			q.firstProposedAt = ts
		}
		if q.title == "" {
			q.title = ancillaryTitle(anc)
		}
		e.mu.Unlock()
	case topicDisputePrice:
		anc, err := parseAncillary(l.Data, 2)
		if err != nil {
			log.Printf("[chain] bad DisputePrice data tx=%s: %v", l.TxHash, err)
			return
		}
		e.markDisputed(keccakHex(anc), ts, "oo_dispute")
	case topicQuestionReset:
		if len(l.Topics) < 2 {
			return
		}
		e.markDisputed(strings.ToLower(l.Topics[1]), ts, "adapter_reset")
	case topicQuestionResolved:
		if len(l.Topics) < 2 {
			return
		}
		e.resolve(strings.ToLower(l.Topics[1]), ts)
	}
}

func (e *engine) ensure(qid string, ts int64) *question {
	e.mu.Lock()
	defer e.mu.Unlock()
	q, ok := e.questions[qid]
	if !ok {
		q = &question{firstSeen: ts}
		e.questions[qid] = q
	}
	return q
}

func (e *engine) markDisputed(qid string, ts int64, via string) {
	e.mu.Lock()
	q, ok := e.questions[qid]
	if !ok {
		e.mu.Unlock()
		log.Printf("[dispute] %s for unknown question %s (proposal outside backfill window?)", via, qid)
		return
	}
	if q.disputed {
		e.mu.Unlock()
		return // count a question once, not per dispute round
	}
	q.disputed = true
	q.firstDisputedAt = ts
	title := q.title
	e.mu.Unlock()
	cat := e.category(qid, title)
	disputesTotal.WithLabelValues(cat).Inc()
	log.Printf("[dispute] qid=%s via=%s category=%s title=%q at=%s", qid, via, cat, title, time.Unix(ts, 0).UTC().Format(time.RFC3339))
}

func (e *engine) resolve(qid string, ts int64) {
	e.mu.Lock()
	q, ok := e.questions[qid]
	if ok {
		delete(e.questions, qid)
	}
	e.mu.Unlock()
	if !ok || q.firstProposedAt == 0 {
		log.Printf("[resolve] skipping %s: no proposal in window (resolved at %s)", qid, time.Unix(ts, 0).UTC().Format(time.RFC3339))
		return
	}
	delay := ts - q.firstProposedAt
	if delay < 0 || delay > 90*24*3600 {
		log.Printf("[resolve] skipping %s: implausible delay %ds", qid, delay)
		return
	}
	cat := e.category(qid, q.title)
	disputed := "false"
	extra := ""
	if q.disputed {
		disputed = "true"
		extra = fmt.Sprintf(" dispute_extra=%ds", ts-q.firstDisputedAt)
	}
	resolutionDelay.WithLabelValues(cat, disputed).Observe(float64(delay))
	resolutionsTotal.WithLabelValues(cat, disputed).Inc()
	log.Printf("[resolve] qid=%s category=%s disputed=%s delay=%ds proposed=%s resolved=%s%s title=%q",
		qid, cat, disputed, delay,
		time.Unix(q.firstProposedAt, 0).UTC().Format(time.RFC3339),
		time.Unix(ts, 0).UTC().Format(time.RFC3339), extra, q.title)
}

// category prefers Gamma event tags (canonical) and falls back to keyword
// classification of the UMA ancillary title.
func (e *engine) category(qid, title string) string {
	if cat, ok := e.gamma.category(qid); ok {
		return cat
	}
	return classifyText(title)
}

func (e *engine) openQuestions() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.questions)
}

// evictStale drops questions that never resolved within 30 days so the map
// stays bounded over months of uptime.
func (e *engine) evictStale() {
	cutoff := time.Now().Add(-30 * 24 * time.Hour).Unix()
	e.mu.Lock()
	n := 0
	for qid, q := range e.questions {
		if q.firstSeen < cutoff {
			delete(e.questions, qid)
			n++
		}
	}
	total := len(e.questions)
	e.mu.Unlock()
	if n > 0 {
		log.Printf("[chain] evicted %d stale questions (>30d unresolved), %d tracked", n, total)
	}
}

// parseAncillary extracts the dynamic `bytes ancillaryData` argument from
// ABI-encoded event data, given its slot index among the non-indexed args
// (slot 2 for both ProposePrice and DisputePrice).
func parseAncillary(dataHex string, slot int) ([]byte, error) {
	raw, err := hex.DecodeString(strings.TrimPrefix(dataHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("hex: %w", err)
	}
	if len(raw) < (slot+1)*32 {
		return nil, fmt.Errorf("data too short (%d bytes)", len(raw))
	}
	off := beUint(raw[slot*32 : (slot+1)*32])
	if off+32 > uint64(len(raw)) {
		return nil, fmt.Errorf("ancillary offset %d out of range", off)
	}
	ln := beUint(raw[off : off+32])
	if off+32+ln > uint64(len(raw)) {
		return nil, fmt.Errorf("ancillary length %d out of range", ln)
	}
	return raw[off+32 : off+32+ln], nil
}

func beUint(b []byte) uint64 {
	var n uint64
	for _, c := range b[len(b)-8:] {
		n = n<<8 | uint64(c)
	}
	// guard: any nonzero byte above the low 8 means a value we treat as overflow
	for _, c := range b[:len(b)-8] {
		if c != 0 {
			return ^uint64(0)
		}
	}
	return n
}

// keccakHex returns 0x-prefixed keccak256 of b. questionID =
// keccak256(ancillaryData) is the documented UmaCtfAdapter derivation,
// verified live: keccak of a ProposePrice ancillary matched the
// QuestionInitialized questionID on the adapter.
func keccakHex(b []byte) string {
	h := sha3.NewLegacyKeccak256()
	h.Write(b)
	return "0x" + hex.EncodeToString(h.Sum(nil))
}

// ancillaryTitle extracts the human title from Polymarket ancillary data,
// which starts with `q: title: <TITLE>, description: ...`.
func ancillaryTitle(anc []byte) string {
	s := string(anc)
	i := strings.Index(s, "title:")
	if i < 0 {
		if len(s) > 120 {
			return s[:120]
		}
		return s
	}
	s = s[i+len("title:"):]
	if j := strings.Index(s, ", description:"); j >= 0 {
		s = s[:j]
	}
	s = strings.TrimSpace(s)
	if len(s) > 160 {
		s = s[:160]
	}
	return s
}
