package main

import (
	"strconv"
	"strings"
	"time"
)

// NEAR Intents, through the 1Click API. Keyless, and the rail that settled
// the delivery question on 2026-10-25: it ACCEPTS a checksum-valid shielded
// Zcash destination, 5 probes out of 5, while Maya refuses one because the
// destination travels in the deposit memo and a 141-character unified
// address does not fit an 80-byte OP_RETURN.
//
// That contrast is the whole point of the delivery probe: the capability
// tracks how a rail carries the recipient, not whether it "supports
// privacy". A rail that takes the recipient in an HTTP body has no such
// ceiling.

const (
	usdcBase = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
	zecNear  = "nep141:zec.omft.near"
)

type oneClickReq struct {
	Dry               bool   `json:"dry"`
	SwapType          string `json:"swapType"`
	Deadline          string `json:"deadline"`
	SlippageTolerance int    `json:"slippageTolerance"`
	OriginAsset       string `json:"originAsset"`
	DestinationAsset  string `json:"destinationAsset"`
	Amount            string `json:"amount"`
	Recipient         string `json:"recipient"`
	RefundTo          string `json:"refundTo"`
	RefundType        string `json:"refundType"`
	DepositType       string `json:"depositType"`
	RecipientType     string `json:"recipientType"`
}

type oneClickResp struct {
	Quote struct {
		AmountOut          string `json:"amountOut"`
		AmountOutFormatted string `json:"amountOutFormatted"`
		TimeEstimate       int    `json:"timeEstimate"`
	} `json:"quote"`
	Message string `json:"message"`
}

func oneClickQuote(cfg *Config, recipient, amount string) (*oneClickResp, int, error) {
	body := oneClickReq{
		Dry:               true,
		SwapType:          "EXACT_INPUT",
		Deadline:          time.Now().UTC().Add(30 * time.Minute).Format("2006-01-02T15:04:05.000Z"),
		SlippageTolerance: 100,
		OriginAsset:       usdcBase,
		DestinationAsset:  zecNear,
		Amount:            amount,
		Recipient:         recipient,
		RefundTo:          "0x0000000000000000000000000000000000000001",
		RefundType:        "ORIGIN_CHAIN",
		DepositType:       "ORIGIN_CHAIN",
		RecipientType:     "DESTINATION_CHAIN",
	}
	var out oneClickResp
	code, err := postJSON(cfg.OneClickBase+"/v0/quote", body, &out)
	return &out, code, err
}

// refusalReason compresses the rail's own words into a stable label.
//
// The raw message cannot be a label: it embeds the address, which would
// create one time series per probe and blow up the cardinality. The mapping
// keeps the mechanism, which is the part worth publishing.
func refusalReason(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "memo too long"):
		return "memo_too_long"
	case strings.Contains(m, "recipient is not valid"), strings.Contains(m, "invalid recipient"):
		return "recipient_rejected"
	case strings.Contains(m, "unable to parse address"):
		return "address_unparsed"
	case strings.Contains(m, "no route"), strings.Contains(m, "not enough"):
		return "no_route"
	case m == "":
		return "unknown"
	default:
		return "other"
	}
}

// probeDelivery is the capability probe, and it refuses to conclude.
//
// The transparent address is tried FIRST and is the control. If the control
// is refused, the shielded result is discarded: three earlier attempts at
// this measurement were voided exactly there, by addresses whose checksums
// failed, which made both probes refuse and looked like a finding.
func probeDelivery(cfg *Config, rail, sourceChain string,
	quote func(recipient string) (accepted bool, message string, err error)) {

	okT, msgT, err := quote(cfg.ZecTransparent)
	if err != nil {
		probeTotal.WithLabelValues(rail, "delivery", "transport_error").Inc()
		return
	}
	transparentOK.WithLabelValues(rail, sourceChain, "ZEC").Set(boolGauge(okT))
	if !okT {
		// Control down: say nothing about shielded. Publishing a 0 here
		// would read as "this rail cannot pay shielded" on the strength of
		// a probe that could not even pay transparent.
		probeTotal.WithLabelValues(rail, "delivery", "control_refused").Inc()
		shieldedRefusals.WithLabelValues(rail, sourceChain, "control_refused:"+refusalReason(msgT)).Inc()
		return
	}

	okS, msgS, err := quote(cfg.ZecShielded)
	if err != nil {
		probeTotal.WithLabelValues(rail, "delivery", "transport_error").Inc()
		return
	}
	shieldedAccepted.WithLabelValues(rail, sourceChain, "ZEC").Set(boolGauge(okS))
	if !okS {
		shieldedRefusals.WithLabelValues(rail, sourceChain, refusalReason(msgS)).Inc()
	}
	probeTotal.WithLabelValues(rail, "delivery", "ok").Inc()
	lastSuccess.WithLabelValues(rail, "delivery").Set(float64(time.Now().Unix()))
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// probeOneClick runs the delivery test on NEAR Intents and records the cost
// of the shielded leg alongside the transparent one. Those two numbers are
// deliberately NOT subtracted into a "shielding fee": measured on
// 2026-10-25 the gap between them was the same order as the quote-to-quote
// movement of either series, so the difference is noise until a long window
// says otherwise. The board can show both and let the reader see that.
func probeOneClick(cfg *Config) {
	const amount = "1000000000" // 1000 USDC, 6 decimals

	probeDelivery(cfg, "near-intents", "base", func(recipient string) (bool, string, error) {
		resp, code, err := oneClickQuote(cfg, recipient, amount)
		if err != nil && code == 0 {
			return false, "", err
		}
		if ok2xx(code) && resp.Quote.AmountOut != "" {
			return true, "", nil
		}
		return false, resp.Message, nil
	})

	// The output each destination kind is quoted, as two plain gauges.
	//
	// Deliberately NOT subtracted into a "shielding fee". Measured on
	// 2026-10-25 over five samples each, the two medians sat 13 bps apart
	// while each series moved 0.10 % between calls on its own, so the gap is
	// the same order as the noise. Publishing a derived penalty would
	// publish that noise with a confident name; publishing both lets the
	// board show they are the same number.
	for _, d := range []struct{ label, addr string }{
		{"transparent", cfg.ZecTransparent},
		{"shielded", cfg.ZecShielded},
	} {
		resp, code, err := oneClickQuote(cfg, d.addr, amount)
		if err != nil || !ok2xx(code) || resp.Quote.AmountOut == "" {
			probeTotal.WithLabelValues("near-intents", "quote_"+d.label, "refused").Inc()
			continue
		}
		out, perr := strconv.ParseFloat(resp.Quote.AmountOutFormatted, 64)
		if perr != nil {
			raw, e2 := strconv.ParseInt(resp.Quote.AmountOut, 10, 64)
			if e2 != nil {
				probeTotal.WithLabelValues("near-intents", "quote_"+d.label, "unparsed").Inc()
				continue
			}
			out = float64(raw) / 1e8
		}
		quoteOut.WithLabelValues("near-intents", "ZEC", d.label, cfg.MonitorRegion).Set(out)
		quoteEta.WithLabelValues("near-intents", "ZEC", d.label, cfg.MonitorRegion).
			Set(float64(resp.Quote.TimeEstimate))
		probeTotal.WithLabelValues("near-intents", "quote_"+d.label, "ok").Inc()
		lastSuccess.WithLabelValues("near-intents", "quote_"+d.label).Set(float64(time.Now().Unix()))
	}
}
