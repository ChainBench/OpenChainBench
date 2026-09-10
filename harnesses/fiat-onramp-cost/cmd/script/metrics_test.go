package main

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func gaugeValue(t *testing.T, g prometheus.Gauge) float64 {
	t.Helper()
	var m dto.Metric
	if err := g.Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetGauge().GetValue()
}

func TestLabelsForAndDelete(t *testing.T) {
	q := NormalizedQuote{Provider: "ramp", Cohort: "onramp", Via: "direct", Asset: "usdc", Network: "base", PaymentMethod: "sepa", Notional: 500, CountrySource: "param"}
	l := labelsFor(q)
	if l["notional"] != "500" || l["fiat"] != "EUR" || l["country"] != "FR" || l["region"] != "eu-west" {
		t.Errorf("%v", l)
	}
	spot := SpotSnapshot{Kraken: map[string]float64{"usdc": 0.92}, Pyth: map[string]float64{"usdc": 0.921}}
	q.FiatIn, q.CryptoOut, q.FeeProvider = 500, 530, 5
	emitQuote(q, spot)
	if v := gaugeValue(t, allInPremium.With(withRef(l, "kraken_eur"))); v == 0 {
		t.Error("premium not emitted")
	}
	DeleteQuoteSeries(l)
	if v := gaugeValue(t, allInPremium.With(withRef(l, "kraken_eur"))); v != 0 {
		t.Errorf("not purged: %v", v)
	}
}
