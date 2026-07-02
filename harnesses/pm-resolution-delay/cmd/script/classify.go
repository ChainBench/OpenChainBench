package main

import "strings"

// Simple keyword classifier into sports|politics|crypto|other. Gamma event
// tag slugs are checked first (canonical, e.g. "tennis", "politics",
// "crypto"); the UMA ancillary title is the fallback when a market resolves
// before we crawled its Gamma event. Precedence sports > politics > crypto:
// sports keywords are the most specific, and mixed cases ("Will Trump pardon
// SBF") should land on the political anchor rather than crypto.

var sportsKeywords = []string{
	" vs ", " vs. ", "o/u", "over/under", "moneyline", "spread:",
	"nba", "nfl", "mlb", "nhl", "ncaa", "wnba", "epl", "premier league",
	"la liga", "serie a", "bundesliga", "ligue 1", "champions league",
	"europa league", "uefa", "fifa", "world cup", "copa", "mls",
	"atp", "wta", "itf", "tennis", "wimbledon", "roland garros", "us open",
	"australian open", "grand slam", "set winner", "match winner",
	"ufc", "mma", "boxing", "f1", "formula 1", "grand prix", "nascar",
	"pga", "golf", "olympic", "super bowl", "stanley cup", "world series",
	"playoffs", "touchdown", "home run", "innings", "rebounds", "assists",
	"esports", "dota", "cs2", "csgo", "counter-strike", "league of legends",
	"valorant", "overwatch", "map 1", "map 2", "first blood", "barracks",
	"soccer", "football", "basketball", "baseball", "hockey", "cricket",
	"rugby", "darts", "snooker", "cycling", "marathon",
}

var politicsKeywords = []string{
	"politics", "election", "president", "presidency", "presidential",
	"senate", "senator", "congress", "house of representatives", "parliament",
	"prime minister", "chancellor", "mayor", "governor", "minister",
	"impeach", "referendum", "coalition", "nominee", "nomination", "cabinet",
	"supreme court", "legislation", "bill passes", "veto", "executive order",
	"ceasefire", "peace deal", "sanctions", "nato", "united nations",
	"geopolitics", "tariff", "white house", "kremlin", "vote share",
	"electoral", "ballot", "primaries", "primary winner", "approval rating",
}

var cryptoKeywords = []string{
	"crypto", "bitcoin", "btc", "ethereum", " eth ", "solana", " sol ",
	"xrp", "doge", "cardano", "token", "stablecoin", "defi", "nft",
	"airdrop", "fdv", "market cap of $", "binance", "coinbase", "tether",
	"satoshi", "halving", "etf approval", "blockchain", "memecoin",
	"altcoin", "all time high", "hit $", "dip to $",
}

func matchAny(text string, kws []string) bool {
	for _, k := range kws {
		if strings.Contains(text, k) {
			return true
		}
	}
	return false
}

// classifyText buckets free text (ancillary title, Gamma question, event
// title). Input is padded with spaces so word-boundary keywords like " eth "
// can match at the edges.
func classifyText(text string) string {
	t := " " + strings.ToLower(text) + " "
	switch {
	case matchAny(t, sportsKeywords):
		return "sports"
	case matchAny(t, politicsKeywords):
		return "politics"
	case matchAny(t, cryptoKeywords):
		return "crypto"
	default:
		return "other"
	}
}

// classifyTags buckets a Gamma event from its tag slugs/labels.
func classifyTags(tags []gammaTag) string {
	var joined strings.Builder
	for _, t := range tags {
		joined.WriteString(" ")
		joined.WriteString(strings.ToLower(t.Slug))
		joined.WriteString(" ")
		joined.WriteString(strings.ToLower(t.Label))
	}
	return classifyText(joined.String())
}
