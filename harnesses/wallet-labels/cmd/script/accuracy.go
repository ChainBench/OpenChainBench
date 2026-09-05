package main

import "strings"

// The bench scores a "hit" whenever a provider returns any non-generic
// name. That rule cannot tell a curated entity label from a personal
// name-service record: a provider that resolves `dex.davywoodfi.eth`
// against Permit2, or `bonklanatoken.sol` against the Raydium authority,
// scores exactly like one that answers "Permit2" and "Raydium".
//
// Measured at the time this was written, on the 100 anchors covered by
// the two API-key providers: 25% of Serialized's hits and 25.4% of
// Mobula's named something other than the curated entity. The bias is
// symmetric, so this is a property of the scoring rule rather than of
// any one vendor.
//
// accurateLabel adds the check the harness could always have made: the
// anchor list already carries a curated Hint for every address and the
// scoring path ignored it. This is published as a SEPARATE series
// (wallet_labels_accurate_total) rather than folded into
// wallet_labels_success_total, so the existing leaderboard and its
// history stay intact while the stricter number builds up alongside.

// normalizeLabel lowercases and strips everything that is not
// alphanumeric, so "Uniswap: Universal Router" and "uniswap universal
// router" compare equal.
func normalizeLabel(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// genericHintWords are words that appear in curated hints but carry no
// entity signal on their own. Without this list "USDC (Base native)"
// would match "jakie.base.eth" through the word "base", scoring a
// personal Basename as a correct label for a token contract.
var genericHintWords = map[string]bool{
	"base": true, "solana": true, "ethereum": true, "polygon": true, "arbitrum": true,
	"optimism": true, "avalanche": true, "bitcoin": true, "stellar": true, "native": true,
	"token": true, "contract": true, "wallet": true, "hot": true, "cold": true,
	"chain": true, "mint": true, "address": true, "factory": true, "proxy": true,
	"deployer": true, "treasury": true, "bridge": true, "pool": true, "vault": true,
	"router": true, "exchange": true, "protocol": true, "official": true, "main": true,
}

// hintTokens splits a curated hint into the words that carry entity
// signal. Bare indices are dropped so "Binance 14" matches on "binance"
// and never on "14", otherwise "Bitstamp 14" would score as a correct
// answer. Generic and chain words are dropped for the same reason. The
// length floor is 3 and not 4: "OKX" is a real entity name.
func hintTokens(hint string) []string {
	repl := strings.NewReplacer(":", " ", "-", " ", "/", " ", "(", " ", ")", " ", ".", " ", "_", " ")
	var out []string
	for _, w := range strings.Fields(strings.ToLower(repl.Replace(hint))) {
		if len(w) < 3 || allDigits(w) || genericHintWords[w] {
			continue
		}
		out = append(out, w)
	}
	return out
}

// labelTokens splits a returned label the same way, so matching happens
// on whole words. Substring matching would let "base" inside
// "jakie.base.eth" pass, which is exactly the false positive this
// series exists to avoid.
func labelTokens(label string) []string {
	repl := strings.NewReplacer(":", " ", "-", " ", "/", " ", "(", " ", ")", " ", ".", " ", "_", " ")
	return strings.Fields(strings.ToLower(repl.Replace(label)))
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

// accurateLabel reports whether the returned label plausibly names the
// entity the anchor was curated for. Permissive on form ("Binance"
// matches "Binance 14", "OKX 7" matches "OKX 1") and strict on identity
// ("Bittrex 3" does not match "OKX 1", "jakie.base.eth" does not match
// "USDC (Base native)").
func accurateLabel(hint, label string) bool {
	if hint == "" || label == "" {
		return false
	}
	h, l := normalizeLabel(hint), normalizeLabel(label)
	if h == "" || l == "" {
		return false
	}
	if h == l {
		return true
	}
	ht := hintTokens(hint)
	if len(ht) == 0 {
		// Hint carried no signal word (e.g. "Binance 14" reduced to
		// nothing would be a bug, but "1" alone would not). Fall back to
		// whole-string containment rather than matching everything.
		return strings.Contains(l, h) || strings.Contains(h, l)
	}
	lt := labelTokens(label)
	for _, hw := range ht {
		for _, lw := range lt {
			if hw == lw || strings.HasPrefix(lw, hw) || strings.HasPrefix(hw, lw) {
				return true
			}
		}
	}
	return false
}
