package main

// Slim Mobula Pulse V2 feeder.
//
// Pulse was removed as a benched aggregator on 2026-04-28 (commit e7f2276ca5)
// because OpenChainBench dropped it from scope. But the metadata coverage
// benchmark depends on Pulse to discover NEW tokens — without that source,
// the metadata_coverage_* gauges stop receiving fresh samples and the dashboard
// goes blank.
//
// This file restores ONLY the data flow into the metadata queue. It does NOT
// emit any pulse-specific Prometheus metrics (no RecordPoolDiscoveryLatency,
// no head_lag_seconds{aggregator="pulse"}). Pulse therefore never re-appears
// in the head_lag dashboard.

import (
	"encoding/json"
	"fmt"
	"log"
	"time"
)

const mobulaPulseWSURL = "wss://pulse-v2-api.mobula.io"

// Chains we care about for token discovery (same launchpad chains as before).
var pulseChains = []string{
	"solana:solana",
	"evm:56",
	"evm:8453",
}

// Source names emitted by Mobula Pulse V2 we treat as "interesting" launchpads.
// Filtering keeps the metadata queue focused on freshly-launched tokens
// (where coverage differences between providers are most visible) instead of
// every Uniswap/Raydium pool creation.
var pulseLaunchpadSources = map[string]bool{
	"pumpfun":      true,
	"pump.fun":     true,
	"meteora":      true,
	"meteora-dbc":  true,
	"meteoradbc":   true,
	"fourmeme":     true,
	"four.meme":    true,
	"flap":         true,
	"zora":         true,
	"baseapp":      true,
	"bags":         true,
	"moonshot":     true,
	"raydium_cpmm": true,
}

type pulseSubscribePayload struct {
	Model      string                  `json:"model"`
	AssetMode  bool                    `json:"assetMode"`
	ChainID    []string                `json:"chainId"`
	Compressed bool                    `json:"compressed"`
	Views      []map[string]any        `json:"views,omitempty"`
}

type pulseSubscribeMsg struct {
	Type          string                `json:"type"`
	Authorization string                `json:"authorization"`
	Payload       pulseSubscribePayload `json:"payload"`
}

type pulseToken struct {
	Address   string `json:"address"`
	Name      string `json:"name"`
	Symbol    string `json:"symbol"`
	ChainID   string `json:"chainId"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
}

type pulseTokenWrapper struct {
	Token  pulseToken `json:"token"`
	Source string     `json:"source"`
}

type pulseNewTokenMsg struct {
	Type    string `json:"type"`
	Payload struct {
		ViewName string            `json:"viewName"`
		Token    pulseTokenWrapper `json:"token"`
		Source   string            `json:"source"`
	} `json:"payload"`
}

func runMobulaPulseMonitor(config *Config, stopChan <-chan struct{}) {
	if config.MobulaAPIKey == "" {
		fmt.Println("[PULSE-FEEDER] MOBULA_API_KEY not set — skipping pulse feeder, metadata coverage queue will stay empty.")
		return
	}

	fmt.Println("[PULSE-FEEDER] Starting (feeds metadata coverage queue only — no head_lag metrics).")

	reconnectDelay := 5 * time.Second
	const maxReconnectDelay = 60 * time.Second

	for {
		select {
		case <-stopChan:
			fmt.Println("[PULSE-FEEDER] Stopped.")
			return
		default:
			err := pulseFeederSession(config, stopChan)
			if err != nil {
				log.Printf("[PULSE-FEEDER] session error: %v — reconnect in %v", err, reconnectDelay)
			}
			select {
			case <-stopChan:
				return
			case <-time.After(reconnectDelay):
				reconnectDelay *= 2
				if reconnectDelay > maxReconnectDelay {
					reconnectDelay = maxReconnectDelay
				}
			}
		}
	}
}

func pulseFeederSession(config *Config, stopChan <-chan struct{}) error {
	headers := map[string][]string{"Authorization": {config.MobulaAPIKey}}
	dialer := getProxyDialer()
	conn, _, err := dialer.Dial(mobulaPulseWSURL, headers)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	sub := pulseSubscribeMsg{
		Type:          "pulse-v2",
		Authorization: config.MobulaAPIKey,
		Payload: pulseSubscribePayload{
			Model:     "default",
			AssetMode: true,
			ChainID:   pulseChains,
			Views: []map[string]any{
				{"name": "new", "sortBy": "created_at", "sortOrder": "desc", "limit": 50},
			},
		},
	}
	if err := conn.WriteJSON(sub); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	fmt.Println("[PULSE-FEEDER] subscribed; queueing launchpad tokens for metadata checks.")

	for {
		select {
		case <-stopChan:
			return nil
		default:
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) != nil || head.Type != "new-token" {
			continue
		}
		var msg pulseNewTokenMsg
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}

		t := msg.Payload.Token.Token
		src := msg.Payload.Token.Source
		if src == "" {
			src = msg.Payload.Source
		}
		if src == "" {
			src = t.Source
		}
		if !pulseLaunchpadSources[src] {
			continue
		}

		QueueTokenForMetadataCheck(TokenToCheck{
			Address:    t.Address,
			ChainID:    t.ChainID,
			Symbol:     t.Symbol,
			Name:       t.Name,
			DetectedAt: time.Now().UTC(),
		})
	}
}
