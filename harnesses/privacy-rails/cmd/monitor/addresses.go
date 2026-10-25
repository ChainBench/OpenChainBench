package main

import (
	"crypto/sha256"
	"errors"
	"math/big"
	"strings"
)

// The guard this harness is built around.
//
// The shielded-payout question was attempted three times before this code
// existed and voided three times, always the same way: an address string
// that was remembered or reconstructed rather than read, whose checksum
// failed, so the rail answered "recipient is not valid" to BOTH the
// shielded and the transparent probe. Two identical refusals prove nothing
// about the rail; they prove the prober is broken.
//
// So the addresses are checked here, at startup, by their own checksums,
// and a failure stops the delivery probe instead of publishing a verdict.

const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// ValidTransparentZec verifies a Zcash t-address: base58 decode, then the
// last four bytes against the double-SHA256 of the payload.
func ValidTransparentZec(a string) bool {
	if !strings.HasPrefix(a, "t1") && !strings.HasPrefix(a, "t3") {
		return false
	}
	n := big.NewInt(0)
	base := big.NewInt(58)
	for _, ch := range a {
		idx := strings.IndexRune(b58, ch)
		if idx < 0 {
			return false
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(idx)))
	}
	raw := n.Bytes()
	// base58 leading '1' characters encode leading zero bytes.
	for i := 0; i < len(a) && a[i] == '1'; i++ {
		raw = append([]byte{0}, raw...)
	}
	if len(raw) < 5 {
		return false
	}
	body, chk := raw[:len(raw)-4], raw[len(raw)-4:]
	first := sha256.Sum256(body)
	second := sha256.Sum256(first[:])
	for i := 0; i < 4; i++ {
		if second[i] != chk[i] {
			return false
		}
	}
	return true
}

const bech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

func bech32Polymod(values []int) int {
	gen := []int{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := 1
	for _, v := range values {
		b := chk >> 25
		chk = ((chk & 0x1ffffff) << 5) ^ v
		for i := 0; i < 5; i++ {
			if (b>>uint(i))&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

// ValidShieldedZec verifies a Zcash unified address (bech32m, hrp "u").
// Mainnet only: a "utest1" address would quote fine and mean nothing.
func ValidShieldedZec(a string) bool {
	if !strings.HasPrefix(a, "u1") {
		return false
	}
	low := strings.ToLower(a)
	if low != a && strings.ToUpper(a) != a {
		return false // mixed case is invalid in bech32
	}
	pos := strings.LastIndex(low, "1")
	if pos < 1 || pos+7 > len(low) {
		return false
	}
	hrp, data := low[:pos], low[pos+1:]
	values := make([]int, 0, len(hrp)*2+1+len(data))
	for _, c := range hrp {
		values = append(values, int(c)>>5)
	}
	values = append(values, 0)
	for _, c := range hrp {
		values = append(values, int(c)&31)
	}
	for _, c := range data {
		idx := strings.IndexRune(bech32Charset, c)
		if idx < 0 {
			return false
		}
		values = append(values, idx)
	}
	return bech32Polymod(values) == 0x2bc830a3
}

// VerifyDestinations is called once at startup. It returns an error rather
// than logging a warning, because a delivery board built on an address the
// rail cannot parse would publish "no rail can pay shielded" and be wrong.
func VerifyDestinations(c *Config) error {
	if !ValidTransparentZec(c.ZecTransparent) {
		return errors.New("ZEC_TRANSPARENT failed base58check: the delivery probe would " +
			"report a refusal that is our bug, not the rail's")
	}
	if !ValidShieldedZec(c.ZecShielded) {
		return errors.New("ZEC_SHIELDED failed bech32m: the delivery probe would " +
			"report a refusal that is our bug, not the rail's")
	}
	return nil
}
