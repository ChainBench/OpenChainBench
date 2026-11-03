package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Internet Computer certified-state finality.
//
// An ICP subnet finalizes a block, executes it, and then certifies the
// resulting state with a threshold signature. Only certified state is
// served to a client: a read_state answer carries a certificate whose tree
// holds `/time`, the batch time (ns) the block maker wrote into the block
// that produced that state. So when the certified time advances, the
// difference between our clock and that time is block made -> finalized,
// executed, certified and delivered to us. It is the ICP counterpart of the
// Avalanche row (production timestamp -> arrival, already final), with the
// block maker's clock as the reference.
//
// The subnet is the NNS (the ICP ledger canister ryjl3-tyaaa-aaaaa-aaaba-cai
// lives on it), reached through the public boundary nodes at icp-api.io with
// an anonymous read_state call, no key. The certificate's BLS signature is
// not verified here: we read a timestamp, we do not act on the state.
//
// A poll only learns that the time advanced somewhere between the previous
// answer and this one, so the arrival moment is the midpoint of the two
// receive times (see pollArrival).

const (
	icpDefaultURL      = "https://icp-api.io"
	icpLedgerCanister  = "ryjl3-tyaaa-aaaaa-aaaba-cai"
	icpPollInterval    = 250 * time.Millisecond
	icpMaxGap          = time.Second
	icpMaxPlausibleLag = 60 * time.Second
)

func StartICPWallClock() {
	base := getenvDefault("RPC_ICP", icpDefaultURL)
	url := base + "/api/v2/canister/" + icpLedgerCanister + "/read_state"
	go func() {
		backoff := 2 * time.Second
		for {
			err := runICPPoll(url)
			if err != nil {
				fmt.Printf("[L1][icp] poll error: %v (retrying in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("icp").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runICPPoll(url string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	tick := time.NewTicker(icpPollInterval)
	defer tick.Stop()
	var st pollArrival
	var lastCert int64
	consecErrors := 0
	healthy := false
	n := 0
	for range tick.C {
		certNs, err := icpCertifiedTime(client, url)
		recv := time.Now()
		if err != nil {
			consecErrors++
			st.miss()
			if consecErrors >= 10 {
				return fmt.Errorf("too many errors: %w", err)
			}
			continue
		}
		consecErrors = 0
		if !healthy {
			wallClockHealth.WithLabelValues("icp").Set(1)
			healthy = true
		}
		advanced := certNs > lastCert
		first := lastCert == 0
		if advanced {
			lastCert = certNs
		}
		seen, ok := st.observe(recv, advanced && !first, icpMaxGap)
		if !ok {
			continue
		}
		lag := seen.Sub(time.Unix(0, certNs))
		if lag < 0 || lag > icpMaxPlausibleLag {
			continue
		}
		ms := float64(lag.Milliseconds())
		recordWallClock("icp", ms)
		if n++; n%40 == 0 {
			fmt.Printf("[L1][icp] certified=%s lag=%.0fms\n", time.Unix(0, certNs).UTC().Format("15:04:05.000"), ms)
		}
	}
	return nil
}

func icpCertifiedTime(client *http.Client, url string) (int64, error) {
	body := icpReadStateTimeRequest(time.Now().Add(3 * time.Minute))
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/cbor")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("status_%d", resp.StatusCode)
	}
	return parseICPReadStateTime(raw)
}

// icpReadStateTimeRequest encodes, in CBOR, an anonymous read_state call
// for the single path ["time"]:
//
//	{"content": {"request_type": "read_state", "sender": h'04',
//	             "paths": [[h'74696d65']], "ingress_expiry": <ns>}}
func icpReadStateTimeRequest(expiry time.Time) []byte {
	var b bytes.Buffer
	b.Write([]byte{0xd9, 0xd9, 0xf7}) // self-describe tag
	cborHead(&b, 5, 1)
	cborText(&b, "content")
	cborHead(&b, 5, 4)
	cborText(&b, "request_type")
	cborText(&b, "read_state")
	cborText(&b, "sender")
	cborHead(&b, 2, 1)
	b.WriteByte(0x04) // anonymous principal
	cborText(&b, "paths")
	cborHead(&b, 4, 1)
	cborHead(&b, 4, 1)
	cborHead(&b, 2, 4)
	b.WriteString("time")
	cborText(&b, "ingress_expiry")
	cborHead(&b, 0, uint64(expiry.UnixNano()))
	return b.Bytes()
}

// parseICPReadStateTime pulls the `/time` leaf out of a read_state answer:
// {"certificate": bstr(cbor {"tree": hashtree, ...})}. The leaf is a LEB128
// natural, nanoseconds since the epoch.
func parseICPReadStateTime(raw []byte) (int64, error) {
	outer, err := cborDecode(raw)
	if err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	m, ok := outer.(map[string]any)
	if !ok {
		return 0, fmt.Errorf("parse: answer is not a map")
	}
	certBytes, ok := m["certificate"].([]byte)
	if !ok {
		if r, ok := m["reject_message"].(string); ok {
			return 0, fmt.Errorf("rejected: %s", r)
		}
		return 0, fmt.Errorf("parse: no certificate")
	}
	certV, err := cborDecode(certBytes)
	if err != nil {
		return 0, fmt.Errorf("parse_cert: %w", err)
	}
	cert, ok := certV.(map[string]any)
	if !ok {
		return 0, fmt.Errorf("parse_cert: not a map")
	}
	leaf, ok := icpLookup(cert["tree"], []byte("time"))
	if !ok {
		return 0, fmt.Errorf("parse_cert: no /time leaf")
	}
	ns, n := binary.Uvarint(leaf)
	if n <= 0 || ns == 0 {
		return 0, fmt.Errorf("parse_cert: bad /time leaf")
	}
	return int64(ns), nil
}

// icpLookup walks a hash tree for a one-label path. Node shapes:
// [0] empty, [1 l r] fork, [2 label sub] labeled, [3 v] leaf, [4 h] pruned.
func icpLookup(node any, label []byte) ([]byte, bool) {
	arr, ok := node.([]any)
	if !ok || len(arr) == 0 {
		return nil, false
	}
	tag, _ := arr[0].(uint64)
	switch tag {
	case 1:
		if len(arr) != 3 {
			return nil, false
		}
		if v, ok := icpLookup(arr[1], label); ok {
			return v, true
		}
		return icpLookup(arr[2], label)
	case 2:
		if len(arr) != 3 {
			return nil, false
		}
		l, _ := arr[1].([]byte)
		if !bytes.Equal(l, label) {
			return nil, false
		}
		sub, ok := arr[2].([]any)
		if !ok || len(sub) != 2 {
			return nil, false
		}
		if t, _ := sub[0].(uint64); t != 3 {
			return nil, false
		}
		v, ok := sub[1].([]byte)
		return v, ok
	}
	return nil, false
}

// --- minimal CBOR (RFC 8949) ------------------------------------------
// Only what read_state needs: unsigned ints, byte and text strings,
// arrays, maps with text keys, tags (skipped). Indefinite lengths and
// floats are not used by the IC and are rejected.

func cborHead(b *bytes.Buffer, major byte, n uint64) {
	m := major << 5
	switch {
	case n < 24:
		b.WriteByte(m | byte(n))
	case n <= 0xff:
		b.WriteByte(m | 24)
		b.WriteByte(byte(n))
	case n <= 0xffff:
		b.WriteByte(m | 25)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	case n <= 0xffffffff:
		b.WriteByte(m | 26)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	default:
		b.WriteByte(m | 27)
		_ = binary.Write(b, binary.BigEndian, n)
	}
}

func cborText(b *bytes.Buffer, s string) {
	cborHead(b, 3, uint64(len(s)))
	b.WriteString(s)
}

func cborDecode(data []byte) (any, error) {
	d := &cborDecoder{buf: data}
	v, err := d.value(0)
	if err != nil {
		return nil, err
	}
	return v, nil
}

type cborDecoder struct {
	buf []byte
	pos int
}

func (d *cborDecoder) head() (byte, uint64, error) {
	if d.pos >= len(d.buf) {
		return 0, 0, fmt.Errorf("cbor: truncated")
	}
	ib := d.buf[d.pos]
	d.pos++
	major, info := ib>>5, ib&0x1f
	var size int
	switch {
	case info < 24:
		return major, uint64(info), nil
	case info == 24:
		size = 1
	case info == 25:
		size = 2
	case info == 26:
		size = 4
	case info == 27:
		size = 8
	default:
		return 0, 0, fmt.Errorf("cbor: unsupported additional info %d", info)
	}
	if d.pos+size > len(d.buf) {
		return 0, 0, fmt.Errorf("cbor: truncated")
	}
	var n uint64
	for i := 0; i < size; i++ {
		n = n<<8 | uint64(d.buf[d.pos+i])
	}
	d.pos += size
	return major, n, nil
}

func (d *cborDecoder) bytesN(n uint64) ([]byte, error) {
	if n > uint64(len(d.buf)-d.pos) {
		return nil, fmt.Errorf("cbor: truncated")
	}
	out := d.buf[d.pos : d.pos+int(n)]
	d.pos += int(n)
	return out, nil
}

func (d *cborDecoder) value(depth int) (any, error) {
	if depth > 64 {
		return nil, fmt.Errorf("cbor: too deep")
	}
	major, n, err := d.head()
	if err != nil {
		return nil, err
	}
	switch major {
	case 0:
		return n, nil
	case 2:
		return d.bytesN(n)
	case 3:
		s, err := d.bytesN(n)
		return string(s), err
	case 4:
		if n > uint64(len(d.buf)) {
			return nil, fmt.Errorf("cbor: bad array length")
		}
		arr := make([]any, 0, n)
		for i := uint64(0); i < n; i++ {
			v, err := d.value(depth + 1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		return arr, nil
	case 5:
		if n > uint64(len(d.buf)) {
			return nil, fmt.Errorf("cbor: bad map length")
		}
		m := make(map[string]any, n)
		for i := uint64(0); i < n; i++ {
			k, err := d.value(depth + 1)
			if err != nil {
				return nil, err
			}
			v, err := d.value(depth + 1)
			if err != nil {
				return nil, err
			}
			if ks, ok := k.(string); ok {
				m[ks] = v
			}
		}
		return m, nil
	case 6:
		return d.value(depth + 1) // tag: keep the content
	}
	return nil, fmt.Errorf("cbor: unsupported major type %d", major)
}
