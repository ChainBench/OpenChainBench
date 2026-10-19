package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The nine majors every ranked provider lists. POL was measured in the
// internal run and left out: Bitculator does not list it, and a basket one
// ranked provider cannot enter is not the same ground for the field.
var majors = []string{"BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK"}

type quote struct {
	price float64
	ts    time.Time // provider's own last-updated stamp; zero when it publishes none
}

type provider struct {
	slug           string
	interval       time.Duration
	startDelay     time.Duration
	assets         []string
	fetch          func(ctx context.Context) (map[string]quote, error)
	enabled        bool
	disabledReason string
}

func providers(cfg config) []provider {
	var out []provider
	add := func(p provider) {
		p.enabled = p.disabledReason == ""
		out = append(out, p)
	}

	// Bitculator: 10,000 requests a month on the key it assigned to this
	// bench. One batch call every five minutes is 8,640 a month.
	bitc := provider{slug: "bitculator", interval: 5 * time.Minute, startDelay: 1 * time.Second, assets: majors}
	bitc.fetch = func(ctx context.Context) (map[string]quote, error) { return fetchBitculator(ctx, cfg.bitculatorKey) }
	if cfg.bitculatorKey == "" {
		bitc.disabledReason = "BITCULATOR_API_KEY unset"
	}
	add(bitc)

	// CoinGecko: the keyless public API, through a proxy because it answers
	// 429 to the VPS's shared address. A demo key, when set, is used instead.
	cg := provider{slug: "coingecko", interval: time.Minute, startDelay: 3 * time.Second, assets: majors}
	if cfg.coingeckoKey == "" && cfg.coingeckoProxy == "" {
		cg.disabledReason = "neither COINGECKO_DEMO_KEY nor COINGECKO_PROXY_URL set"
	} else {
		client := directClient
		if cfg.coingeckoKey == "" {
			if c, err := proxyClient(cfg.coingeckoProxy); err == nil {
				client = c
			} else {
				cg.disabledReason = "COINGECKO_PROXY_URL invalid"
			}
		}
		cg.fetch = func(ctx context.Context) (map[string]quote, error) {
			return fetchCoinGecko(ctx, client, cfg.coingeckoKey)
		}
	}
	add(cg)

	// CoinPaprika: keyless, 25,000 requests a month and 60 an hour per
	// address. Nine single-coin calls every 20 minutes is 27 an hour and
	// about 19,400 a month. Its prices refresh about every five minutes, so
	// a sparser poll loses no information.
	pap := provider{slug: "coinpaprika", interval: 20 * time.Minute, startDelay: 5 * time.Second, assets: majors}
	pap.fetch = fetchCoinPaprika
	add(pap)

	coinstats := provider{slug: "coinstats", interval: 2 * time.Minute, startDelay: 7 * time.Second, assets: majors}
	coinstats.fetch = func(ctx context.Context) (map[string]quote, error) { return fetchCoinStats(ctx, cfg.coinstatsKey) }
	if cfg.coinstatsKey == "" {
		coinstats.disabledReason = "COINSTATS_API_KEY unset"
	}
	add(coinstats)

	mob := provider{slug: "mobula", interval: 30 * time.Second, startDelay: 9 * time.Second, assets: majors}
	mob.fetch = func(ctx context.Context) (map[string]quote, error) { return fetchMobula(ctx, cfg.mobulaKey) }
	if cfg.mobulaKey == "" {
		mob.disabledReason = "MOBULA_API_KEY unset"
	}
	add(mob)

	// On-chain DEX prices, listed unranked: they price the wrapped token in
	// its pools rather than the coin's market, and cover the majors that
	// have a canonical on-chain twin. BTC is left out on purpose: WBTC
	// trades 15 to 20 bps under BTC, measured 2026-10-19 on Binance's
	// WBTC/BTC book and on a KyberSwap quote, so scoring WBTC against BTC
	// would charge the provider for the wrapper's discount.
	codex := provider{slug: "codex", interval: time.Minute, startDelay: 11 * time.Second, assets: onchainAssets("codex")}
	codex.fetch = func(ctx context.Context) (map[string]quote, error) { return fetchCodex(ctx, cfg.codexKey) }
	if cfg.codexKey == "" {
		codex.disabledReason = "CODEX_API_KEY unset"
	}
	add(codex)

	ser := provider{slug: "serialized", interval: time.Minute, startDelay: 13 * time.Second, assets: onchainAssets("serialized")}
	ser.fetch = func(ctx context.Context) (map[string]quote, error) { return fetchSerialized(ctx, cfg.serializedKey) }
	if cfg.serializedKey == "" {
		ser.disabledReason = "SERIALIZED_API_KEY unset"
	}
	add(ser)

	return out
}

// ---- Bitculator -------------------------------------------------------

var bitculatorSlug = map[string]string{
	"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binance-coin", "XRP": "xrp",
	"ADA": "cardano", "DOGE": "dogecoin", "AVAX": "avalanche", "LINK": "chainlink",
}

func fetchBitculator(ctx context.Context, key string) (map[string]quote, error) {
	slugs := make([]string, 0, len(majors))
	inv := map[string]string{}
	for _, a := range majors {
		slugs = append(slugs, bitculatorSlug[a])
		inv[bitculatorSlug[a]] = a
	}
	var r struct {
		Data []struct {
			Slug        string `json:"slug"`
			Price       string `json:"price"`
			LastUpdated string `json:"last_updated"`
		} `json:"data"`
	}
	if err := getJSON(ctx, nil, "https://bitculator.com/api/v1/prices?slugs="+strings.Join(slugs, ","),
		map[string]string{"Authorization": "Bearer " + key}, &r); err != nil {
		return nil, err
	}
	out := map[string]quote{}
	for _, c := range r.Data {
		a, ok := inv[c.Slug]
		if !ok {
			continue
		}
		// Prices are decimal strings; float64 keeps 15 significant digits,
		// far below the basis-point resolution this bench reports.
		p, err := strconv.ParseFloat(c.Price, 64)
		if err != nil {
			continue
		}
		q := quote{price: p}
		if t, err := time.Parse(time.RFC3339, c.LastUpdated); err == nil {
			q.ts = t
		}
		out[a] = q
	}
	return out, nil
}

// ---- CoinGecko ----------------------------------------------------------

var coingeckoID = map[string]string{
	"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binancecoin", "XRP": "ripple",
	"ADA": "cardano", "DOGE": "dogecoin", "AVAX": "avalanche-2", "LINK": "chainlink",
}

func fetchCoinGecko(ctx context.Context, client *http.Client, key string) (map[string]quote, error) {
	ids := make([]string, 0, len(majors))
	inv := map[string]string{}
	for _, a := range majors {
		ids = append(ids, coingeckoID[a])
		inv[coingeckoID[a]] = a
	}
	var headers map[string]string
	if key != "" {
		headers = map[string]string{"x-cg-demo-api-key": key}
	}
	var r map[string]struct {
		USD           float64 `json:"usd"`
		LastUpdatedAt int64   `json:"last_updated_at"`
	}
	if err := getJSON(ctx, client, "https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_last_updated_at=true&ids="+strings.Join(ids, ","),
		headers, &r); err != nil {
		return nil, err
	}
	out := map[string]quote{}
	for id, v := range r {
		if a, ok := inv[id]; ok {
			q := quote{price: v.USD}
			if v.LastUpdatedAt > 0 {
				q.ts = time.Unix(v.LastUpdatedAt, 0)
			}
			out[a] = q
		}
	}
	return out, nil
}

// ---- CoinPaprika --------------------------------------------------------

var paprikaID = map[string]string{
	"BTC": "btc-bitcoin", "ETH": "eth-ethereum", "SOL": "sol-solana", "BNB": "bnb-binance-coin", "XRP": "xrp-xrp",
	"ADA": "ada-cardano", "DOGE": "doge-dogecoin", "AVAX": "avax-avalanche", "LINK": "link-chainlink",
}

func fetchCoinPaprika(ctx context.Context) (map[string]quote, error) {
	out := map[string]quote{}
	var lastErr error
	for _, a := range majors {
		var r struct {
			LastUpdated string `json:"last_updated"`
			Quotes      struct {
				USD struct {
					Price float64 `json:"price"`
				} `json:"USD"`
			} `json:"quotes"`
		}
		if err := getJSON(ctx, nil, "https://api.coinpaprika.com/v1/tickers/"+paprikaID[a], nil, &r); err != nil {
			lastErr = err
			// A rate limit stops the round: the next calls would only
			// deepen it.
			if classify(err) == "rate_limited" {
				break
			}
			continue
		}
		q := quote{price: r.Quotes.USD.Price}
		if t, err := time.Parse(time.RFC3339, r.LastUpdated); err == nil {
			q.ts = t
		}
		out[a] = q
	}
	if len(out) == 0 && lastErr != nil {
		return nil, lastErr
	}
	return out, nil
}

// ---- CoinStats ----------------------------------------------------------

var coinstatsID = map[string]string{
	"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binance-coin", "XRP": "ripple",
	"ADA": "cardano", "DOGE": "dogecoin", "AVAX": "avalanche-2", "LINK": "chainlink",
}

func fetchCoinStats(ctx context.Context, key string) (map[string]quote, error) {
	var r struct {
		Result []struct {
			ID    string  `json:"id"`
			Price float64 `json:"price"`
		} `json:"result"`
	}
	if err := getJSON(ctx, nil, "https://openapiv1.coinstats.app/coins?limit=100",
		map[string]string{"X-API-KEY": key}, &r); err != nil {
		return nil, err
	}
	inv := map[string]string{}
	for a, id := range coinstatsID {
		inv[id] = a
	}
	out := map[string]quote{}
	for _, c := range r.Result {
		if a, ok := inv[c.ID]; ok {
			out[a] = quote{price: c.Price}
		}
	}
	return out, nil
}

// ---- Mobula -------------------------------------------------------------

// Mobula is addressed by its numeric asset id. By name or by symbol the
// lookup can land on another asset: in the internal run "Bitcoin" answered
// 9e-14 USD three times out of 66, a different token carrying the name.
var mobulaID = map[string]string{
	"BTC": "100001656", "ETH": "100004304", "SOL": "100010811", "BNB": "100001566", "XRP": "100009923",
	"ADA": "100002304", "DOGE": "100003734", "AVAX": "100001119", "LINK": "100002460",
}

func fetchMobula(ctx context.Context, key string) (map[string]quote, error) {
	ids := make([]string, 0, len(majors))
	inv := map[string]string{}
	for _, a := range majors {
		ids = append(ids, mobulaID[a])
		inv[mobulaID[a]] = a
	}
	var r struct {
		Data map[string]*struct {
			Price float64 `json:"price"`
		} `json:"data"`
	}
	if err := getJSON(ctx, nil, "https://api.mobula.io/api/1/market/multi-data?ids="+strings.Join(ids, ","),
		map[string]string{"Authorization": key}, &r); err != nil {
		return nil, err
	}
	out := map[string]quote{}
	for id, v := range r.Data {
		if a, ok := inv[id]; ok && v != nil {
			out[a] = quote{price: v.Price}
		}
	}
	return out, nil
}

// ---- On-chain twins (Codex, Serialized) ---------------------------------

type onchainToken struct {
	serializedChain string
	codexNetwork    int
	address         string
}

var onchainTwin = map[string]onchainToken{
	"ETH":  {"evm:1", 1, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"},            // WETH
	"SOL":  {"solana", 1399811149, "So11111111111111111111111111111111111111112"}, // wSOL
	"BNB":  {"evm:56", 56, "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"},          // WBNB
	"LINK": {"evm:1", 1, "0x514910771af9ca656af840dff83e8264ecf986ca"},            // LINK
	"AVAX": {"evm:43114", 43114, "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"},    // WAVAX
}

// Serialized does not index Avalanche (its token endpoint answers NOT_FOUND
// for WAVAX), so its basket is four assets and Codex's five.
func onchainAssets(slug string) []string {
	if slug == "serialized" {
		return []string{"ETH", "SOL", "BNB", "LINK"}
	}
	return []string{"ETH", "SOL", "BNB", "LINK", "AVAX"}
}

func fetchCodex(ctx context.Context, key string) (map[string]quote, error) {
	assets := onchainAssets("codex")
	inputs := make([]string, 0, len(assets))
	for _, a := range assets {
		t := onchainTwin[a]
		inputs = append(inputs, fmt.Sprintf(`{address:"%s",networkId:%d}`, t.address, t.codexNetwork))
	}
	q := fmt.Sprintf(`{getTokenPrices(inputs:[%s]){address networkId priceUsd timestamp}}`, strings.Join(inputs, ","))
	var r struct {
		Data struct {
			GetTokenPrices []*struct {
				PriceUsd  float64 `json:"priceUsd"`
				Timestamp int64   `json:"timestamp"`
			} `json:"getTokenPrices"`
		} `json:"data"`
	}
	if err := postJSON(ctx, nil, "https://graph.codex.io/graphql", map[string]string{"Authorization": key},
		map[string]string{"query": q}, &r); err != nil {
		return nil, err
	}
	out := map[string]quote{}
	for i, p := range r.Data.GetTokenPrices {
		if p == nil || i >= len(assets) {
			continue
		}
		qq := quote{price: p.PriceUsd}
		if p.Timestamp > 0 {
			qq.ts = time.Unix(p.Timestamp, 0)
		}
		out[assets[i]] = qq
	}
	return out, nil
}

func fetchSerialized(ctx context.Context, key string) (map[string]quote, error) {
	assets := onchainAssets("serialized")
	items := make([]map[string]string, 0, len(assets))
	for _, a := range assets {
		t := onchainTwin[a]
		items = append(items, map[string]string{"chain": t.serializedChain, "address": t.address})
	}
	var r struct {
		Data []struct {
			Data *struct {
				PriceUsd float64 `json:"priceUsd"`
			} `json:"data"`
		} `json:"data"`
	}
	if err := postJSON(ctx, nil, "https://api.serialized.xyz/v1/token/price", map[string]string{"Authorization": key},
		map[string]any{"items": items}, &r); err != nil {
		return nil, err
	}
	out := map[string]quote{}
	for i, slot := range r.Data {
		if slot.Data == nil || i >= len(assets) {
			continue
		}
		out[assets[i]] = quote{price: slot.Data.PriceUsd}
	}
	return out, nil
}
