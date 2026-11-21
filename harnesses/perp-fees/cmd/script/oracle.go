package main

import (
	"errors"
	"fmt"
	"math"
	"net/http"
)

type sideCosts struct {
	Long     float64
	Short    float64
	LongFee  float64
	ShortFee float64
}

func (c sideCosts) averageBps() float64 {
	return (c.Long + c.Short) / 2
}

func (c sideCosts) averageFeeBps() float64 {
	return (c.LongFee + c.ShortFee) / 2
}

type oracleQuote struct {
	Costs sideCosts
	Err   error
}

type oracleProbe struct {
	CallsFor func(notional float64) []ethCallMsg
	CostFrom func(results []string) (sideCosts, error)
}

var errNoQuote = errors.New("no quote for notional")

const maxOracleCostBps = 1000

func oracleNotionals(headline float64) []float64 {
	out := append([]float64{}, tierNotionals...)
	for _, n := range tierNotionals {
		if n == headline {
			return out
		}
	}
	return append(out, headline)
}

func quoteOracle(
	client *http.Client,
	rpcURL string,
	notionals []float64,
	probe oracleProbe,
) (map[float64]oracleQuote, error) {
	var msgs []ethCallMsg
	spans := make([]int, len(notionals))
	for i, n := range notionals {
		calls := probe.CallsFor(n)
		spans[i] = len(calls)
		msgs = append(msgs, calls...)
	}
	outcomes, err := ethCallBatch(client, rpcURL, msgs)
	if err != nil {
		return nil, err
	}
	quotes := make(map[float64]oracleQuote, len(notionals))
	start := 0
	for i, n := range notionals {
		group := outcomes[start : start+spans[i]]
		start += spans[i]
		quotes[n] = quoteFrom(group, probe.CostFrom)
	}
	return quotes, nil
}

func quoteFrom(
	group []ethCallOutcome,
	costFrom func([]string) (sideCosts, error),
) oracleQuote {
	results := make([]string, len(group))
	for i, o := range group {
		if o.Err != nil {
			return oracleQuote{Err: o.Err}
		}
		results[i] = o.Result
	}
	costs, err := costFrom(results)
	if err != nil {
		return oracleQuote{Err: err}
	}
	if math.Abs(costs.Long) > maxOracleCostBps || math.Abs(costs.Short) > maxOracleCostBps {
		return oracleQuote{Err: fmt.Errorf("cost off the oracle by %.0f/%.0f bps", costs.Long, costs.Short)}
	}
	return oracleQuote{Costs: costs}
}

func quoteAt(quotes map[float64]oracleQuote, notional float64) (sideCosts, error) {
	q, ok := quotes[notional]
	if !ok {
		return sideCosts{}, errNoQuote
	}
	return q.Costs, q.Err
}

func applyOracleQuotes(s *PerpSample, headline float64, quotes map[float64]oracleQuote) {
	for _, n := range oracleNotionals(headline) {
		if _, err := quoteAt(quotes, n); err != nil {
			s.Err = fmt.Sprintf("price_impact at $%s: %v", notionalLabel(n), err)
			return
		}
	}
	for _, n := range tierNotionals {
		costs, _ := quoteAt(quotes, n)
		s.Tiers = append(s.Tiers, TierSample{
			Notional:  notionalLabel(n),
			SpreadBps: costs.averageBps(),
			AllInBps:  costs.averageFeeBps() + costs.averageBps(),
		})
	}
	costs, _ := quoteAt(quotes, headline)
	s.TakerFeeBps = costs.averageFeeBps()
	s.SpreadBps = costs.averageBps()
	s.AllInBps = s.TakerFeeBps + s.SpreadBps
}
