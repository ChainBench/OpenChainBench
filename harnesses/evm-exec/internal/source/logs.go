package source

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

const transferTopic0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// ERC20Transfer is one token Transfer event emitted to a recipient.
type ERC20Transfer struct {
	TxHash    string
	BlockNum  uint64
	LogIndex  uint64
	BlockTime time.Time // from blockTimestamp in getLogs response; zero if not present
	Amount    *big.Int  // raw token units (never divided in Go)
}

// RPCError is a JSON-RPC level error; used to detect range-too-large codes.
type RPCError struct {
	Code    int
	Message string
}

func (e *RPCError) Error() string { return fmt.Sprintf("RPC %d: %s", e.Code, e.Message) }

// IsRangeError returns true when the RPC error means the block range is too wide.
func IsRangeError(err error) bool {
	rpcErr, ok := err.(*RPCError)
	if !ok {
		return false
	}
	// -32005: range too large (Alchemy/Infura), -32602: invalid params (geth),
	// -32614: range limit exceeded (base mainnet.base.org)
	return rpcErr.Code == -32005 || rpcErr.Code == -32602 || rpcErr.Code == -32614
}

// GetERC20Transfers fetches Transfer events from [fromBlock, toBlock] for one window.
func GetERC20Transfers(ctx context.Context, rpcURL, tokenContract, recipient string, fromBlock, toBlock uint64) ([]ERC20Transfer, error) {
	// topic2: 32-byte left-padded address (12 zero bytes + 20 addr bytes).
	topic2 := "0x" + strings.Repeat("0", 24) + strings.TrimPrefix(strings.ToLower(recipient), "0x")

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"method": "eth_getLogs",
		"params": []any{map[string]any{
			"fromBlock": fmt.Sprintf("0x%x", fromBlock),
			"toBlock":   fmt.Sprintf("0x%x", toBlock),
			"address":   tokenContract,
			"topics":    []any{transferTopic0, nil, topic2},
		}},
	})

	var out struct {
		Result []struct {
			TxHash         string   `json:"transactionHash"`
			BlockNumber    string   `json:"blockNumber"`
			BlockTimestamp string   `json:"blockTimestamp"` // hex unix seconds; present on Base, absent on ETH/BSC
			LogIndex       string   `json:"logIndex"`
			Data           string   `json:"data"`
			Topics         []string `json:"topics"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := RpcPost(ctx, rpcURL, body, &out); err != nil {
		return nil, fmt.Errorf("eth_getLogs: %w", err)
	}
	if out.Error != nil {
		return nil, &RPCError{Code: out.Error.Code, Message: out.Error.Message}
	}

	var transfers []ERC20Transfer
	for _, log := range out.Result {
		if len(log.Data) < 2 || len(log.Topics) < 3 {
			continue
		}
		blockNum, err := ParseHex64(log.BlockNumber)
		if err != nil {
			continue
		}
		logIdx, err := ParseHex64(log.LogIndex)
		if err != nil {
			continue
		}
		amount, ok := new(big.Int).SetString(strings.TrimPrefix(log.Data, "0x"), 16)
		if !ok || amount.Sign() <= 0 {
			continue
		}
		var bt time.Time
		if ts, err2 := ParseHex64(log.BlockTimestamp); err2 == nil && ts > 0 {
			bt = time.Unix(int64(ts), 0).UTC()
		}
		transfers = append(transfers, ERC20Transfer{
			TxHash:    strings.ToLower(log.TxHash),
			BlockNum:  blockNum,
			LogIndex:  logIdx,
			BlockTime: bt,
			Amount:    amount,
		})
	}
	return transfers, nil
}

// GetERC20TransfersAdaptive fetches all ERC-20 transfers from fromBlock to toBlock
// using adaptive range sizing (halves on range error, grows on success).
func GetERC20TransfersAdaptive(ctx context.Context, rpcURL, tokenContract, recipient string, fromBlock, toBlock uint64) ([]ERC20Transfer, uint64, error) {
	const maxRange = uint64(10_000)
	rangeSize := maxRange
	var all []ERC20Transfer
	cur := fromBlock

	for cur <= toBlock {
		end := cur + rangeSize - 1
		if end > toBlock {
			end = toBlock
		}

		batch, err := GetERC20Transfers(ctx, rpcURL, tokenContract, recipient, cur, end)
		if err != nil {
			if IsRangeError(err) && rangeSize > 100 {
				rangeSize /= 2
				continue
			}
			select {
			case <-ctx.Done():
				return all, cur - 1, ctx.Err()
			case <-time.After(3 * time.Second):
			}
			batch, err = GetERC20Transfers(ctx, rpcURL, tokenContract, recipient, cur, end)
			if err != nil {
				return all, cur - 1, fmt.Errorf("eth_getLogs [%d,%d]: %w", cur, end, err)
			}
		}

		all = append(all, batch...)
		if rangeSize < maxRange {
			rangeSize = rangeSize * 125 / 100
			if rangeSize > maxRange {
				rangeSize = maxRange
			}
		}
		cur = end + 1
	}
	return all, toBlock, nil
}

// ParseDecAmount parses a decimal-string wei amount (Etherscan format) to *big.Int.
func ParseDecAmount(s string) (*big.Int, error) {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil, fmt.Errorf("bad decimal amount: %q", s)
	}
	return v, nil
}

// ParseHexAmount parses a 0x-prefixed hex wei amount (NodeReal format) to *big.Int.
func ParseHexAmount(s string) (*big.Int, error) {
	v, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("bad hex amount: %q", s)
	}
	return v, nil
}

// LogIndexKey returns the event_key string for an ERC-20 log.
func LogIndexKey(logIndex uint64) string {
	return strconv.FormatUint(logIndex, 10)
}
