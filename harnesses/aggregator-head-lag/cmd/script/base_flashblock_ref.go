package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/sha3"
)

// Base preconfirmation reference.
//
// The reference clock elsewhere in this package observes a trade when the
// sealed block carrying it reaches our node. On Base that is too late to be
// the zero point, and measurably so: a Base block only becomes queryable
// +0.36 s after the timestamp it carries (median over 25 consecutive
// blocks), while the sequencer publishes flashblock preconfirmations every
// 200 ms inside the 2 s interval. A provider reading that stream therefore
// delivers a trade ~1.3 s before the block it will belong to is stamped,
// which is why measuring against the block timestamp produced negative lag
// for 99% of one provider's Base emissions.
//
// Subscribing here puts the zero point where the information actually
// becomes public. Every provider on Base is then measured against the same
// instant regardless of which layer it reads, and nobody is negative by
// construction. Verified before shipping from two datacenters: Serialized
// +0.239 s (Paris) / +0.244 s (laptop) against this reference, stable, with
// 4 negatives out of 125 left as network jitter.
//
// The endpoint is public and anycast: 1.1 ms RTT from both the Paris and
// Singapore boxes, the same distance as the provider endpoints themselves,
// so no region is handicapped relative to the feeds it measures.
//
// Only Base needs this. Solana, BNB and Robinhood carry no preconfirmation
// layer a provider consumes, and their chain-supplied timestamps sit within
// ~60 ms of the moment the trade is observable, so they keep the existing
// ruler.

const baseFlashblocksDefaultURL = "wss://mainnet.flashblocks.base.org/ws"

func baseFlashblocksURL() string {
	if v := strings.TrimSpace(os.Getenv("BASE_FLASHBLOCKS_WS_URL")); v != "" {
		return v
	}
	return baseFlashblocksDefaultURL
}

// flashblockPayload is the subset we read. `diff.transactions` holds the
// raw RLP transactions added by this flashblock, hex encoded.
type flashblockPayload struct {
	Index int64 `json:"index"`
	Diff  struct {
		Transactions []string `json:"transactions"`
	} `json:"diff"`
}

var keccakPool = sync.Pool{New: func() any { return sha3.NewLegacyKeccak256() }}

// txHashFromRaw derives a transaction hash the way the chain does:
// keccak256 over the raw encoded transaction. Verified against
// eth_getTransactionByHash before shipping.
func txHashFromRaw(raw string) (string, bool) {
	raw = strings.TrimPrefix(strings.TrimSpace(raw), "0x")
	if raw == "" {
		return "", false
	}
	b, err := hex.DecodeString(raw)
	if err != nil {
		return "", false
	}
	h := keccakPool.Get().(interface {
		io.Writer
		Reset()
		Sum([]byte) []byte
	})
	h.Reset()
	_, _ = h.Write(b)
	sum := h.Sum(nil)
	keccakPool.Put(h)
	return "0x" + hex.EncodeToString(sum), true
}

// runBaseFlashblockReference feeds the shared reference clock from Base's
// preconfirmation stream. Never fatal: if the endpoint is unreachable the
// clock simply holds no Base entries, and the provider monitors count the
// misses rather than silently falling back to a different ruler.
func runBaseFlashblockReference(stopChan <-chan struct{}) {
	url := baseFlashblocksURL()
	if url == "" {
		log.Printf("[HEAD-LAG][REF][base] flashblocks disabled (empty URL)")
		return
	}
	delay := 2 * time.Second
	const maxDelay = 60 * time.Second
	for {
		select {
		case <-stopChan:
			return
		default:
		}
		if err := baseFlashblockConnect(url, stopChan); err != nil {
			log.Printf("[HEAD-LAG][REF][base] flashblocks: %v (retry in %v)", err, delay)
			select {
			case <-stopChan:
				return
			case <-time.After(delay):
			}
			if delay *= 2; delay > maxDelay {
				delay = maxDelay
			}
			continue
		}
		delay = 2 * time.Second
	}
}

func baseFlashblockConnect(url string, stopChan <-chan struct{}) error {
	// Plain dialer for the same reason as refConnect: the scraping proxy
	// would add its own latency to the reference and flatter every
	// provider measured against it.
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	fmt.Printf("[HEAD-LAG][REF][base] flashblocks connected to %s\n", url)

	// The server pushes without a subscription frame. A silent socket is a
	// dead reference, so fail out and reconnect rather than sit on it.
	for {
		select {
		case <-stopChan:
			return nil
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		seen := time.Now().UTC()

		decoded, err := io.ReadAll(brotli.NewReader(strings.NewReader(string(msg))))
		if err != nil {
			// Not every frame is necessarily compressed; try raw JSON.
			decoded = msg
		}
		var fb flashblockPayload
		if json.Unmarshal(decoded, &fb) != nil {
			continue
		}
		for _, raw := range fb.Diff.Transactions {
			if h, ok := txHashFromRaw(raw); ok {
				reference.observe("base", h, seen)
				RecordFlashblockObserved()
			}
		}
	}
}
