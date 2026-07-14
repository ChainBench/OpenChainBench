package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// Ethereum builder attribution via block extraData.
//
// Same philosophy as bench 016 (solana-tx-landing): a curated table of
// known-entity tags, plus explicit logging of every string we could NOT
// attribute so the table grows from operator logs instead of silently
// under-counting. Builders self-label their blocks in extraData
// ("Titan (titanbuilder.xyz)", "beaverbuild.org", ...); vanilla
// (locally-built) blocks carry the execution client's default tag
// (geth/reth/besu/nethermind version strings) or are empty.
//
// extraData is self-reported: a builder could change or strip its tag
// at any time. The methodology in the spec discloses this; the relay
// bidtrace cross-check (relays.go) provides an independent signal.

// builderRule maps a lowercase substring of the decoded extraData to a
// canonical builder slug. Order matters: first match wins, so put the
// most specific substrings first.
type builderRule struct {
	substr string
	slug   string
}

// builderTable is the curated attribution table. Slugs are the Prom
// label values the spec YAML queries. Verified against live mainnet
// blocks at bench inception (50-block sample: Titan 19, Quasar 16,
// Eureka 6, BuilderNet 2, beaverbuild 1, Builder+ 1, vanilla 1).
var builderTable = []builderRule{
	// Specific multi-word tags first.
	{"bob-the-builder", "bobthebuilder"},
	{"bobthebuilder", "bobthebuilder"},
	{"builder0x69", "builder0x69"},
	{"penguinbuild", "penguinbuild"},
	{"beaverbuild", "beaverbuild"},
	{"buildernet", "buildernet"},
	{"builder+", "btcs"}, // BTCS "Builder+"
	{"btcs", "btcs"},
	{"titan", "titan"},
	{"quasar", "quasar"},
	{"eureka", "eureka"},
	{"rsync", "rsync"},
	// Flashbots historically tags "Illuminate Dmocratize Dstribute".
	{"flashbots", "flashbots"},
	{"illuminate", "flashbots"},
	{"dmocratize", "flashbots"},
	{"bloxroute", "bloxroute"},
	{"gambit", "gambit"},
	{"antbuilder", "antbuilder"},
	{"manifold", "manifold"},
	{"blockbeelder", "blockbeelder"},
	{"jetbldr", "jetbuilder"},
	{"payload", "payload"},
	{"boba-builder", "boba"},
}

// vanillaTags identify execution-client default extraData: the proposer
// built the block locally instead of outsourcing to a builder. These
// count as "vanilla", NOT as unattributed - a locally-built block is a
// positive decentralization signal, not a table gap.
var vanillaTags = []string{
	"geth", "go1.", "nethermind", "besu", "reth", "erigon", "linux",
	"darwin", "windows", "ubuntu",
}

// slugOther collects blocks whose extraData carries a tag we don't
// recognize. Every occurrence is logged with the raw string so the
// table can be grown (016 pattern).
const (
	slugOther   = "other"
	slugVanilla = "vanilla"
)

// decodeExtraData turns the hex extraData field into a printable string
// for substring matching. Non-printable bytes (client tags like geth
// pack RLP fragments around the ASCII) are dropped.
func decodeExtraData(hexStr string) string {
	raw, err := hex.DecodeString(strings.TrimPrefix(hexStr, "0x"))
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, c := range raw {
		if c >= 0x20 && c <= 0x7e {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// attributeBuilder maps decoded extraData to a builder slug.
// Returns (slug, attributed). attributed=false means the tag was
// non-empty and unrecognized (goes to "other" + unattributed counter).
func attributeBuilder(decoded string) (string, bool) {
	lower := strings.ToLower(decoded)
	if strings.TrimSpace(lower) == "" {
		return slugVanilla, true
	}
	for _, r := range builderTable {
		if strings.Contains(lower, r.substr) {
			return r.slug, true
		}
	}
	for _, t := range vanillaTags {
		if strings.Contains(lower, t) {
			return slugVanilla, true
		}
	}
	return slugOther, false
}

type ethBlock struct {
	Number    string `json:"number"`
	ExtraData string `json:"extraData"`
}

// runBuilderPoll polls the ETH head every slot (12s), attributes each
// new block's extraData and backfills small gaps by number so the
// market-share counters see every block, not just the ones that happen
// to be head at poll time.
func runBuilderPoll(ctx context.Context) {
	url := ethRPCURL()
	fmt.Printf("[eth] builder attribution poll: %s every %s\n", url, ethPollInterval)

	var lastSeen int64
	t := time.NewTicker(ethPollInterval)
	defer t.Stop()
	for {
		var head ethBlock
		err := jsonRPCCall(url, "eth_getBlockByNumber", []any{"latest", false}, &head)
		if err != nil {
			ethPollHealth.Set(0)
			ethPollErrors.Inc()
			fmt.Printf("[eth] poll error: %v\n", err)
		} else {
			ethPollHealth.Set(1)
			headNum := parseHexInt64(head.Number)
			if headNum > lastSeen {
				// Backfill missed blocks (cap 10: a longer gap means we were
				// down; counting a burst of stale blocks then would skew the
				// 5m rate series without changing 24h share meaningfully).
				start := headNum
				if lastSeen > 0 {
					start = lastSeen + 1
					if headNum-lastSeen > 10 {
						start = headNum - 10 + 1
					}
				}
				for n := start; n < headNum; n++ {
					var blk ethBlock
					if err := jsonRPCCall(url, "eth_getBlockByNumber",
						[]any{fmt.Sprintf("0x%x", n), false}, &blk); err != nil {
						fmt.Printf("[eth] backfill %d error: %v\n", n, err)
						continue
					}
					recordBlock(n, blk.ExtraData)
				}
				recordBlock(headNum, head.ExtraData)
				lastSeen = headNum
				ethLastBlock.Set(float64(headNum))
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func recordBlock(num int64, extraHex string) {
	decoded := decodeExtraData(extraHex)
	slug, attributed := attributeBuilder(decoded)
	blocksTotal.WithLabelValues(slug).Inc()
	if !attributed {
		unattributedTotal.Inc()
		// The whole point of the log line: grow the table from operator
		// logs, exactly like 016 logs unattributable tip patterns.
		fmt.Printf("[eth] UNATTRIBUTED block=%d extraData=%q raw=%s\n", num, decoded, extraHex)
	} else {
		fmt.Printf("[eth] block=%d builder=%s extraData=%q\n", num, slug, decoded)
	}
}
