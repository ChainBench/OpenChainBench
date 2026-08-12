package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/ChainBench/OpenChainBench/harnesses/evm-exec/internal/platform"
	"github.com/ChainBench/OpenChainBench/harnesses/evm-exec/internal/source"
	"github.com/ChainBench/OpenChainBench/harnesses/evm-exec/internal/store"
)

var chainRPC map[string]string

func main() {
	chainRPC = map[string]string{
		"ethereum":  envOrDefault("ETH_RPC_URL", "https://eth.drpc.org"),
		"bsc":       bscRPC(),
		"base":      envOrDefault("BASE_RPC_URL", "https://base.drpc.org"),
		"robinhood": envOrDefault("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
	}

	ctx := context.Background()
	db, err := store.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("collector: %v", err)
	}
	defer db.Close()

	etherscanKey := mustEnv("ETHERSCAN_API_KEY")

	if err := bootstrap(ctx, db); err != nil {
		log.Fatalf("collector: bootstrap: %v", err)
	}
	log.Printf("collector: ready")

	for {
		for plt, chains := range platform.PlatformConfig {
			for chain, cfg := range chains {
				if err := collectPlatform(ctx, db, etherscanKey, plt, chain, cfg); err != nil {
					log.Printf("collector: %s/%s: %v", plt, chain, err)
				}
			}
		}
		time.Sleep(10 * time.Minute)
	}
}

// bootstrap seeds cursors at (head - 30d) for each (platform, chain, asset) that has no cursor.
func bootstrap(ctx context.Context, db *store.DB) error {
	for plt, chains := range platform.PlatformConfig {
		for chain, cfg := range chains {
			rpc := chainRPC[chain]
			head, err := source.HeadBlock(ctx, rpc)
			if err != nil {
				return err
			}
			bpd := platform.BlocksPerDay[chain]
			start := uint64(0)
			if head > bpd*uint64(cfg.BootstrapDays) {
				start = head - bpd*uint64(cfg.BootstrapDays)
			}

			for _, token := range cfg.ERC20Tokens {
				if err := db.SeedCursorIfAbsent(ctx, chain, plt, token, start); err != nil {
					return err
				}
			}
			if cfg.NativeEnabled {
				if err := db.SeedCursorIfAbsent(ctx, chain, plt, "native", start); err != nil {
					return err
				}
			}
			log.Printf("collector: bootstrap %s/%s start=%d", plt, chain, start)
		}
	}
	return nil
}

func collectPlatform(ctx context.Context, db *store.DB, etherscanKey, plt, chain string, cfg platform.EVMPlatform) error {
	rpc := chainRPC[chain]
	toBlock, err := finalityBlock(ctx, rpc, chain)
	if err != nil {
		return err
	}

	for _, token := range cfg.ERC20Tokens {
		if err := collectERC20(ctx, db, rpc, plt, chain, cfg.FeeCollector, token, toBlock); err != nil {
			log.Printf("collector: %s/%s ERC20 %s...: %v", plt, chain, token[:8], err)
		}
	}

	if cfg.NativeEnabled {
		switch chain {
		case "ethereum":
			if err := collectNativeEtherscan(ctx, db, etherscanKey, source.ChainIDEthereum, plt, chain, cfg.FeeCollector, toBlock); err != nil {
				log.Printf("collector: %s/%s native ETH: %v", plt, chain, err)
			}
		case "base":
			if err := collectNativeEtherscan(ctx, db, etherscanKey, source.ChainIDBase, plt, chain, cfg.FeeCollector, toBlock); err != nil {
				log.Printf("collector: %s/%s native ETH on Base: %v", plt, chain, err)
			}
		case "bsc":
			if err := collectNativeBSC(ctx, db, plt, chain, cfg.FeeCollector, toBlock); err != nil {
				log.Printf("collector: %s/%s native BNB: %v", plt, chain, err)
			}
		case "robinhood":
			if err := collectNativeBlockscout(ctx, db, plt, chain, cfg.FeeCollector, toBlock); err != nil {
				log.Printf("collector: %s/%s native ETH (Blockscout): %v", plt, chain, err)
			}
		}
	}
	return nil
}

func collectERC20(ctx context.Context, db *store.DB, rpc, plt, chain, collector, token string, toBlock uint64) error {
	cursor, _, err := db.GetCursor(ctx, chain, plt, token)
	if err != nil {
		return fmt.Errorf("get cursor: %w", err)
	}
	if cursor >= toBlock {
		return nil
	}
	decimals := platform.TokenDecimals[token]

	transfers, lastBlock, err := source.GetERC20TransfersAdaptive(ctx, rpc, token, collector, cursor+1, toBlock)
	if err != nil {
		return err
	}

	events := make([]store.EVMEvent, 0, len(transfers))
	for _, t := range transfers {
		var bt time.Time
		if !t.BlockTime.IsZero() {
			bt = t.BlockTime
			_ = db.CacheBlockTime(ctx, chain, t.BlockNum, bt)
		} else {
			var err error
			bt, err = resolveBlockTime(ctx, db, rpc, chain, t.BlockNum)
			if err != nil {
				continue
			}
		}
		events = append(events, store.EVMEvent{
			Chain: chain, TxHash: t.TxHash, BlockNum: t.BlockNum, BlockTime: bt,
			Platform: plt, Asset: token, AmountRaw: t.Amount,
			Decimals: decimals, EventKey: source.LogIndexKey(t.LogIndex),
		})
	}
	if err := db.UpsertEvents(ctx, events); err != nil {
		return err
	}
	if lastBlock > cursor {
		_ = db.SaveCursor(ctx, chain, plt, token, lastBlock)
	}
	if len(events) > 0 {
		log.Printf("collector: %s/%s ERC20 %d events block=%d", plt, chain, len(events), lastBlock)
	}
	return nil
}

func collectNativeEtherscan(ctx context.Context, db *store.DB, apiKey, chainID, plt, chain, collector string, toBlock uint64) error {
	cursor, _, err := db.GetCursor(ctx, chain, plt, "native")
	if err != nil {
		return fmt.Errorf("get cursor: %w", err)
	}

	internalTxs, lastInt, err := source.GetEtherscanInternalTxs(ctx, apiKey, chainID, collector, cursor)
	if err != nil {
		return err
	}
	normalTxs, lastNorm, err := source.GetEtherscanNormalTxs(ctx, apiKey, chainID, collector, cursor)
	if err != nil {
		return err
	}

	rpc := chainRPC[chain]
	var events []store.EVMEvent
	for _, tx := range append(internalTxs, normalTxs...) {
		if tx.BlockNum > toBlock {
			continue
		}
		var bt time.Time
		if !tx.BlockTime.IsZero() {
			bt = tx.BlockTime
			_ = db.CacheBlockTime(ctx, chain, tx.BlockNum, bt)
		} else {
			var err error
			bt, err = resolveBlockTime(ctx, db, rpc, chain, tx.BlockNum)
			if err != nil {
				continue
			}
		}
		events = append(events, store.EVMEvent{
			Chain: chain, TxHash: tx.TxHash, BlockNum: tx.BlockNum, BlockTime: bt,
			Platform: plt, Asset: "native", AmountRaw: tx.Amount,
			Decimals: 18, EventKey: tx.EventKey,
		})
	}
	if err := db.UpsertEvents(ctx, events); err != nil {
		return err
	}
	if high := max64(lastInt, lastNorm); high > cursor {
		_ = db.SaveCursor(ctx, chain, plt, "native", high)
	}
	if len(events) > 0 {
		log.Printf("collector: %s/%s native ETH %d events", plt, chain, len(events))
	}
	return nil
}

func collectNativeBlockscout(ctx context.Context, db *store.DB, plt, chain, collector string, toBlock uint64) error {
	cursor, _, err := db.GetCursor(ctx, chain, plt, "native")
	if err != nil {
		return fmt.Errorf("get cursor: %w", err)
	}
	if cursor >= toBlock {
		return nil
	}
	rpc := chainRPC[chain]

	internalTxs, lastInt, err := source.GetBlockscoutInternalTxs(ctx, source.BlockscoutRobinhood, collector, cursor)
	if err != nil {
		return err
	}
	normalTxs, lastNorm, err := source.GetBlockscoutNormalTxs(ctx, source.BlockscoutRobinhood, collector, cursor)
	if err != nil {
		return err
	}

	var events []store.EVMEvent
	for _, tx := range append(internalTxs, normalTxs...) {
		if tx.BlockNum > toBlock {
			continue
		}
		var bt time.Time
		if !tx.BlockTime.IsZero() {
			bt = tx.BlockTime
			_ = db.CacheBlockTime(ctx, chain, tx.BlockNum, bt)
		} else {
			bt, err = resolveBlockTime(ctx, db, rpc, chain, tx.BlockNum)
			if err != nil {
				continue
			}
		}
		events = append(events, store.EVMEvent{
			Chain: chain, TxHash: tx.TxHash, BlockNum: tx.BlockNum, BlockTime: bt,
			Platform: plt, Asset: "native", AmountRaw: tx.Amount,
			Decimals: 18, EventKey: tx.EventKey,
		})
	}
	if err := db.UpsertEvents(ctx, events); err != nil {
		return err
	}
	if high := max64(lastInt, lastNorm); high > cursor {
		_ = db.SaveCursor(ctx, chain, plt, "native", high)
	}
	if len(events) > 0 {
		log.Printf("collector: %s/%s native ETH (Blockscout) %d events block=%d", plt, chain, len(events), max64(lastInt, lastNorm))
	}
	return nil
}

func collectNativeBSC(ctx context.Context, db *store.DB, plt, chain, collector string, toBlock uint64) error {
	cursor, _, err := db.GetCursor(ctx, chain, plt, "native")
	if err != nil {
		return fmt.Errorf("get cursor: %w", err)
	}
	if cursor >= toBlock {
		return nil
	}
	rpc := chainRPC[chain]

	transfers, err := source.GetNativeTransfers(ctx, rpc, collector, cursor+1, toBlock)
	if err != nil {
		return err
	}

	var events []store.EVMEvent
	var highBlock uint64
	for _, t := range transfers {
		var bt time.Time
		if !t.BlockTime.IsZero() {
			bt = t.BlockTime
			_ = db.CacheBlockTime(ctx, chain, t.BlockNum, bt)
		} else {
			var err error
			bt, err = resolveBlockTime(ctx, db, rpc, chain, t.BlockNum)
			if err != nil {
				continue
			}
		}
		events = append(events, store.EVMEvent{
			Chain: chain, TxHash: t.TxHash, BlockNum: t.BlockNum, BlockTime: bt,
			Platform: plt, Asset: "native", AmountRaw: t.Amount,
			Decimals: 18, EventKey: t.EventKey,
		})
		if t.BlockNum > highBlock {
			highBlock = t.BlockNum
		}
	}
	if err := db.UpsertEvents(ctx, events); err != nil {
		return err
	}
	if highBlock > cursor {
		_ = db.SaveCursor(ctx, chain, plt, "native", highBlock)
	}
	if len(events) > 0 {
		log.Printf("collector: %s/%s native BNB %d events block=%d", plt, chain, len(events), highBlock)
	}
	return nil
}

func resolveBlockTime(ctx context.Context, db *store.DB, rpc, chain string, blockNum uint64) (time.Time, error) {
	if t, ok := db.GetBlockTime(ctx, chain, blockNum); ok {
		return t, nil
	}
	t, err := source.BlockTime(ctx, rpc, blockNum)
	if err != nil {
		return time.Time{}, err
	}
	_ = db.CacheBlockTime(ctx, chain, blockNum, t)
	return t, nil
}

func finalityBlock(ctx context.Context, rpc, chain string) (uint64, error) {
	switch chain {
	case "ethereum", "base":
		return source.ResolveBlockTag(ctx, rpc, "finalized")
	case "bsc":
		head, err := source.HeadBlock(ctx, rpc)
		if err != nil {
			return 0, err
		}
		if head > 20 {
			return head - 20, nil
		}
		return 0, nil
	default:
		return source.HeadBlock(ctx, rpc)
	}
}

func bscRPC() string {
	if v := os.Getenv("BSC_RPC_URL"); v != "" {
		return v
	}
	key := os.Getenv("NODEREAL_BSC_KEY")
	if key == "" {
		log.Fatal("collector: NODEREAL_BSC_KEY or BSC_RPC_URL is required")
	}
	return "https://bsc-mainnet.nodereal.io/v1/" + key
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing env: %s", key)
	}
	return v
}

func max64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}
