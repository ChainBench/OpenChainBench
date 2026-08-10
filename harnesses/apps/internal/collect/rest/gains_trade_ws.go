package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

const gainsWSS = "wss://backend-arbitrum.gains.trade"
const gainsArbRPC = "https://arb1.arbitrum.io/rpc"

// topic0 hashes extracted from on-chain receipts (Gains Diamond, Arbitrum)
const (
	topicGovFeeCharged    = "0xeb561f0609b402569e8a7e8fe9d4f408b92c96fb83001b2cd78fd55c29bbbac3"
	topicGTokenFeeCharged = "0xfe4ab97508a97bb85ad1e2680662e58549e51982d965eed4ef6d7fcd4cc4295f"
)

// collateral token decimals on Arbitrum (Gains collateralIndex → decimals)
var gainsCollDecimals = map[int]int{
	1: 6,  // USDC.e
	2: 18, // DAI
	3: 6,  // USDC (native)
	4: 18, // ETH
}

// GainsTradeWSCollector streams real-time trade events from the gTrade first-party
// WebSocket and resolves exact fee amounts via eth_getTransactionReceipt.
// arb1.arbitrum.io allows receipt lookups without auth; no API key needed.
type GainsTradeWSCollector struct {
	client *http.Client
}

func NewGainsTradeWS() *GainsTradeWSCollector {
	return &GainsTradeWSCollector{client: &http.Client{Timeout: 10 * time.Second}}
}

type wsTradeMsg struct {
	Name               string  `json:"name"`
	Date               string  `json:"date"`
	TX                 string  `json:"tx"`
	CollateralIndex    string  `json:"collateralIndex"`
	CollateralPriceUsd float64 `json:"collateralPriceUsd"`
}

// Stream connects to the gTrade Arbitrum WebSocket and sends fee events for every
// trade that settled after `after`. It returns on connection error; the caller
// is responsible for reconnecting.
func (c *GainsTradeWSCollector) Stream(ctx context.Context, deploymentID string, after time.Time, out chan<- spec.FeeEvent) error {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.DialContext(ctx, gainsWSS, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var msg wsTradeMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if msg.Name != "new-trade-history" || msg.TX == "" {
			continue
		}

		ts, err := parseGainsDate(msg.Date)
		if err != nil || !ts.After(after) {
			continue
		}
		if msg.CollateralPriceUsd <= 0 {
			msg.CollateralPriceUsd = 1.0
		}

		collIdx := 3
		if n, err := strconv.Atoi(msg.CollateralIndex); err == nil {
			collIdx = n
		}
		decimals := gainsCollDecimals[collIdx]
		if decimals == 0 {
			decimals = 6
		}

		govMicro, lpMicro, err := c.fetchFees(ctx, msg.TX, decimals, msg.CollateralPriceUsd)
		if err != nil || (govMicro == 0 && lpMicro == 0) {
			continue
		}

		h := uint64(ts.Unix())
		txKey := strings.ToLower(msg.TX)

		if govMicro > 0 {
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     "gains:arb:treasury:tx:" + txKey,
				Ts:           ts,
				Height:       h,
				Component:    "position_fee",
				Beneficiary:  "treasury",
				Token:        "USD",
				AmountRaw:    strconv.FormatInt(govMicro, 10),
				Decimals:     6,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       "gains-trade-ws",
			}
		}
		if lpMicro > 0 {
			out <- spec.FeeEvent{
				DeploymentID: deploymentID,
				EventKey:     "gains:arb:lp:tx:" + txKey,
				Ts:           ts,
				Height:       h,
				Component:    "position_fee",
				Beneficiary:  "lp",
				Token:        "USD",
				AmountRaw:    strconv.FormatInt(lpMicro, 10),
				Decimals:     6,
				Market:       "all",
				Finality:     spec.FinalityFinal,
				Source:       "gains-trade-ws",
			}
		}
	}
}

func parseGainsDate(s string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02T15:04:05.999Z", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unparseable date: %s", s)
}

type arbRPCReq struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
	ID      int    `json:"id"`
}

type arbRPCResp struct {
	Result *struct {
		Logs []struct {
			Topics []string `json:"topics"`
			Data   string   `json:"data"`
		} `json:"logs"`
	} `json:"result"`
	Error *struct{ Message string } `json:"error"`
}

func (c *GainsTradeWSCollector) fetchFees(ctx context.Context, txHash string, collDecimals int, collPriceUSD float64) (govMicro, lpMicro int64, err error) {
	body, _ := json.Marshal(arbRPCReq{
		JSONRPC: "2.0",
		Method:  "eth_getTransactionReceipt",
		Params:  []any{txHash},
		ID:      1,
	})

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gainsArbRPC, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	var rpc arbRPCResp
	if err := json.NewDecoder(resp.Body).Decode(&rpc); err != nil {
		return 0, 0, err
	}
	if rpc.Error != nil {
		return 0, 0, fmt.Errorf("rpc: %s", rpc.Error.Message)
	}
	if rpc.Result == nil {
		return 0, 0, fmt.Errorf("no receipt: %s", txHash)
	}

	divisor := new(big.Float).SetFloat64(math.Pow10(collDecimals))

	for _, log := range rpc.Result.Logs {
		if len(log.Topics) == 0 {
			continue
		}
		t0 := log.Topics[0]
		if t0 != topicGovFeeCharged && t0 != topicGTokenFeeCharged {
			continue
		}
		rawHex := strings.TrimPrefix(log.Data, "0x")
		if len(rawHex) < 64 {
			continue
		}
		rawInt := new(big.Int)
		rawInt.SetString(rawHex[:64], 16)

		amtF := new(big.Float).SetInt(rawInt)
		amtF.Quo(amtF, divisor)
		amtUSD, _ := amtF.Float64()
		micro := int64(math.Round(amtUSD * collPriceUSD * 1e6))

		switch t0 {
		case topicGovFeeCharged:
			govMicro += micro
		case topicGTokenFeeCharged:
			lpMicro += micro
		}
	}

	return govMicro, lpMicro, nil
}
