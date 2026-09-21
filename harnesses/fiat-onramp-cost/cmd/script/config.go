package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Persona. Fixed on purpose: every provider is asked the same question.
// Changing any of these is a spec change, not a config change, so they are
// constants with env overrides only for the notional/asset lists that the
// spec dimensions already enumerate.
const (
	PersonaCountry = "FR"
	PersonaFiat    = "EUR"
	PersonaRegion  = "eu-west"
)

// AssetSpec ties a persona asset to the network it is bought on and to
// each provider's naming for both. Fallback network is used only when the
// primary is not offered by the provider for this asset.
type AssetSpec struct {
	Asset    string // btc, usdc, eth
	Network  string // bitcoin, base, ethereum
	Fallback string // arbitrum for usdc, "" otherwise
}

var DefaultAssets = []AssetSpec{
	{Asset: "btc", Network: "bitcoin"},
	{Asset: "usdc", Network: "base", Fallback: "arbitrum"},
	{Asset: "eth", Network: "ethereum"},
}

var DefaultNotionals = []float64{100, 500}
var DefaultPaymentMethods = []string{"card", "sepa"}

type Config struct {
	CycleSeconds   int
	Notionals      []float64
	Assets         []AssetSpec
	PaymentMethods []string
	EnableATM      bool
	ListenAddr     string

	// Provider credentials. Empty means the provider is skipped, not failed.
	MoonPayPK        string
	TransakAPIKey    string
	TransakStaging   bool
	RampHostAPIKey   string
	MercuryoWidgetID string
	OnramperAPIKey   string
	MeldAPIKey       string
	MeldSandbox      bool

	// Per-provider request budget per cycle, to stay inside documented
	// rate limits. Ramp documents 100 req/min per source IP; one cycle asks
	// at most assets × notionals × methods = 12 quotes per provider.
	ProviderSemaphore int
}

func loadConfig() *Config {
	c := &Config{
		CycleSeconds:      envInt("CYCLE_SECONDS", 300),
		Notionals:         DefaultNotionals,
		Assets:            DefaultAssets,
		PaymentMethods:    DefaultPaymentMethods,
		EnableATM:         envBool("ENABLE_ATM_COHORT", false),
		ListenAddr:        env("LISTEN_ADDR", ":2113"),
		MoonPayPK:         env("MOONPAY_PK", ""),
		TransakAPIKey:     env("TRANSAK_API_KEY", ""),
		TransakStaging:    envBool("TRANSAK_STAGING", false),
		RampHostAPIKey:    env("RAMP_HOST_API_KEY", ""),
		MercuryoWidgetID:  env("MERCURYO_WIDGET_ID", ""),
		OnramperAPIKey:    env("ONRAMPER_API_KEY", ""),
		MeldAPIKey:        env("MELD_API_KEY", ""),
		MeldSandbox:       envBool("MELD_SANDBOX", false),
		ProviderSemaphore: envInt("PROVIDER_CONCURRENCY", 2),
	}
	if v := env("NOTIONALS", ""); v != "" {
		c.Notionals = nil
		for _, s := range strings.Split(v, ",") {
			if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil && f > 0 {
				c.Notionals = append(c.Notionals, f)
			}
		}
	}
	if v := env("PAYMENT_METHODS", ""); v != "" {
		c.PaymentMethods = nil
		for _, s := range strings.Split(v, ",") {
			if m := strings.TrimSpace(strings.ToLower(s)); m != "" {
				c.PaymentMethods = append(c.PaymentMethods, m)
			}
		}
	}
	if v := env("ASSETS", ""); v != "" {
		keep := map[string]bool{}
		for _, s := range strings.Split(v, ",") {
			keep[strings.TrimSpace(strings.ToLower(s))] = true
		}
		var out []AssetSpec
		for _, a := range DefaultAssets {
			if keep[a.Asset] {
				out = append(out, a)
			}
		}
		if len(out) > 0 {
			c.Assets = out
		}
	}
	return c
}

func (c *Config) Cycle() time.Duration { return time.Duration(c.CycleSeconds) * time.Second }

// Redacted returns the config as shown on /config: every secret replaced
// by whether it is set, so a reader can reproduce the run without the keys.
func (c *Config) Redacted() map[string]any {
	set := func(s string) string {
		if s == "" {
			return "unset"
		}
		return "set"
	}
	return map[string]any{
		"persona":              map[string]string{"country": PersonaCountry, "fiat": PersonaFiat, "region": PersonaRegion},
		"cycle_seconds":        c.CycleSeconds,
		"notionals":            c.Notionals,
		"assets":               c.Assets,
		"payment_methods":      c.PaymentMethods,
		"enable_atm_cohort":    c.EnableATM,
		"provider_concurrency": c.ProviderSemaphore,
		"keys": map[string]string{
			"MOONPAY_PK": set(c.MoonPayPK), "TRANSAK_API_KEY": set(c.TransakAPIKey),
			"RAMP_HOST_API_KEY": set(c.RampHostAPIKey), "MERCURYO_WIDGET_ID": set(c.MercuryoWidgetID),
			"ONRAMPER_API_KEY": set(c.OnramperAPIKey), "MELD_API_KEY": set(c.MeldAPIKey),
		},
		"transak_staging": c.TransakStaging,
		"meld_sandbox":    c.MeldSandbox,
	}
}

func env(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}
func envInt(k string, d int) int {
	if v, err := strconv.Atoi(env(k, "")); err == nil && v > 0 {
		return v
	}
	return d
}
func envBool(k string, d bool) bool {
	switch strings.ToLower(env(k, "")) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return d
}

func (c *Config) Print() {
	fmt.Printf("Config: cycle=%ds notionals=%v methods=%v assets=%d atm=%v\n",
		c.CycleSeconds, c.Notionals, c.PaymentMethods, len(c.Assets), c.EnableATM)
	fmt.Printf("Keys: moonpay=%v transak=%v(staging=%v) ramp=%v mercuryo=%v onramper=%v meld=%v(sandbox=%v)\n",
		c.MoonPayPK != "", c.TransakAPIKey != "", c.TransakStaging, c.RampHostAPIKey != "",
		c.MercuryoWidgetID != "", c.OnramperAPIKey != "", c.MeldAPIKey != "", c.MeldSandbox)
}
