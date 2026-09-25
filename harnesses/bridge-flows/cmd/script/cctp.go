package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"golang.org/x/crypto/sha3"
)

// Circle CCTP burns. A USDC transfer over CCTP burns on the source chain
// (DepositForBurn) and mints on the destination; the burn event carries
// the amount and the destination domain, so one scan per source chain
// gives the full corridor matrix out of that chain.
//
// v1: DepositForBurn(uint64 indexed nonce, address indexed burnToken,
//
//	uint256 amount, address indexed depositor, bytes32 mintRecipient,
//	uint32 destinationDomain, bytes32 destinationTokenMessenger,
//	bytes32 destinationCaller)
//
// v2: DepositForBurn(address indexed burnToken, uint256 amount,
//
//	address indexed depositor, bytes32 mintRecipient,
//	uint32 destinationDomain, bytes32 destinationTokenMessenger,
//	bytes32 destinationCaller, uint256 maxFee,
//	uint32 indexed minFinalityThreshold, bytes hookData)
//
// In both, data word 0 is the amount and data word 2 the destination
// domain. burnToken is an indexed topic in both: topics[2] for v1 (after
// nonce), topics[1] for v2.
const (
	sigV1 = "DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)"
	sigV2 = "DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)"
)

var topicV1, topicV2 string

func keccakTopic(sig string) string {
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte(sig))
	return "0x" + hex.EncodeToString(h.Sum(nil))
}

func init() {
	topicV1 = keccakTopic(sigV1)
	topicV2 = keccakTopic(sigV2)
}

// burn is one decoded DepositForBurn.
type burn struct {
	amountUSD float64
	dest      uint32
	block     int64
	version   int
}

// decodeBurn returns ok=false for logs that are not a USDC DepositForBurn
// of a known version (EURC burns, reorged logs, other events).
func decodeBurn(l ethLog, usdc string) (burn, bool) {
	if l.Removed || len(l.Topics) == 0 {
		return burn{}, false
	}
	var version int
	var tokenTopic string
	switch strings.ToLower(l.Topics[0]) {
	case topicV1:
		if len(l.Topics) < 3 {
			return burn{}, false
		}
		version, tokenTopic = 1, l.Topics[2]
	case topicV2:
		if len(l.Topics) < 2 {
			return burn{}, false
		}
		version, tokenTopic = 2, l.Topics[1]
	default:
		return burn{}, false
	}
	if !strings.EqualFold(topicAddress(tokenTopic), usdc) {
		return burn{}, false
	}
	data := strings.TrimPrefix(l.Data, "0x")
	if len(data) < 3*64 {
		return burn{}, false
	}
	amount, ok := new(big.Int).SetString(data[0:64], 16)
	if !ok {
		return burn{}, false
	}
	dest, ok := new(big.Int).SetString(data[128:192], 16)
	if !ok || !dest.IsUint64() || dest.Uint64() > 1<<31 {
		return burn{}, false
	}
	blk, err := parseHexInt(l.BlockNumber)
	if err != nil {
		return burn{}, false
	}
	usd, _ := new(big.Float).Quo(new(big.Float).SetInt(amount), big.NewFloat(1e6)).Float64()
	return burn{amountUSD: usd, dest: uint32(dest.Uint64()), block: blk, version: version}, true
}

func topicAddress(t string) string {
	t = strings.TrimPrefix(strings.ToLower(t), "0x")
	if len(t) < 40 {
		return ""
	}
	return "0x" + t[len(t)-40:]
}

// scanner keeps one chain's cursor and hourly buckets.
type scanner struct {
	chain Chain
	rpc   *rpcClient
	state *State
	chunk int64
}

func newScanner(c Chain, gap time.Duration, st *State) *scanner {
	return &scanner{chain: c, rpc: newRPCClient(c.Slug, c.RPCs, gap), state: st, chunk: c.MaxChunk}
}

// scan advances the chain's cursor to the current head, folding every
// USDC burn into the hourly bucket of its (interpolated) block time. The
// first run starts HistoryHours back. Returns the number of burns folded
// and the last error (nil when the head was reached).
func (s *scanner) scan(ctx context.Context, historyHours int) (int, error) {
	head, err := s.rpc.blockNumber(ctx)
	if err != nil {
		return 0, fmt.Errorf("blockNumber: %w", err)
	}
	// Leave a small reorg margin off the head.
	head -= 3
	cur := s.state.cursor(s.chain.Slug)
	if cur == 0 {
		// Estimate the block that is historyHours old from a recent sample.
		headTS, err := s.rpc.blockTime(ctx, head)
		if err != nil {
			return 0, fmt.Errorf("blockTime head: %w", err)
		}
		sample := head - 1000
		sampleTS, err := s.rpc.blockTime(ctx, sample)
		if err != nil {
			return 0, fmt.Errorf("blockTime sample: %w", err)
		}
		secPerBlock := float64(headTS-sampleTS) / 1000
		if secPerBlock <= 0 {
			secPerBlock = 2
		}
		cur = head - int64(float64(historyHours*3600)/secPerBlock)
		if cur < 1 {
			cur = 1
		}
		log.Printf("[%s] cold start: scanning from block %d (%.2fs/block, %dh back)", s.chain.Slug, cur, secPerBlock, historyHours)
	}
	if cur >= head {
		return 0, nil
	}
	addresses := []string{s.chain.V2}
	if s.chain.V1 != "" {
		addresses = append(addresses, s.chain.V1)
	}
	topics := [][]string{{topicV1, topicV2}}
	nFolded := 0
	from := cur + 1
	for from <= head {
		if ctx.Err() != nil {
			return nFolded, ctx.Err()
		}
		to := from + s.chunk - 1
		if to > head {
			to = head
		}
		logs, err := s.rpc.getLogs(ctx, from, to, addresses, topics)
		if err == errRangeTooWide {
			if s.chunk <= 200 {
				return nFolded, fmt.Errorf("getLogs: range refused at %d blocks", s.chunk)
			}
			s.chunk /= 2
			continue
		}
		if err != nil {
			return nFolded, fmt.Errorf("getLogs %d-%d: %w", from, to, err)
		}
		fromTS, err := s.rpc.blockTime(ctx, from)
		if err != nil {
			return nFolded, fmt.Errorf("blockTime %d: %w", from, err)
		}
		toTS := fromTS
		if to > from {
			if toTS, err = s.rpc.blockTime(ctx, to); err != nil {
				return nFolded, fmt.Errorf("blockTime %d: %w", to, err)
			}
		}
		items := make([]folded, 0, len(logs))
		for _, l := range logs {
			b, ok := decodeBurn(l, s.chain.USDC)
			if !ok {
				continue
			}
			// Linear interpolation inside the chunk: chunks are at most a
			// few hours, buckets are hourly.
			ts := fromTS
			if to > from {
				ts = fromTS + (toTS-fromTS)*(b.block-from)/(to-from)
			}
			items = append(items, folded{ts: ts, dest: b.dest, usd: b.amountUSD})
			burnsTotal.WithLabelValues(s.chain.Slug, fmt.Sprintf("v%d", b.version)).Inc()
		}
		// Buckets and cursor move together (see State.addChunk).
		s.state.addChunk(s.chain.Slug, items, to)
		nFolded += len(items)
		from = to + 1
		// Grow the chunk back slowly after a shrink, up to the configured cap.
		if s.chunk < s.chain.MaxChunk {
			s.chunk = min64(s.chain.MaxChunk, s.chunk+s.chunk/4+1)
		}
	}
	s.state.prune(s.chain.Slug, historyHours)
	return nFolded, nil
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
