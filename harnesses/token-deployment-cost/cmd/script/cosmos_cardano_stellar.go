package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"
)

// Cosmos TokenFactory chains: the chain governance sets a flat
// `denom_creation_fee` on the tokenfactory module. We read it via
// LCD /osmosis/tokenfactory/v1beta1/params (Osmosis path) or the
// equivalent /injective/tokenfactory and /neutron/tokenfactory paths.
//
// Some chains return [] (no fee, gas only). We surface that as zero
// native cost and let the bench page render a "<$0.0001 / no protocol
// fee" badge.

type cosmosSampler struct {
	http *http.Client
}

type cardanoSampler struct {
	http *http.Client
}

type stellarSampler struct {
	http *http.Client
}

func init() {
	registerSampler(KindCosmos, &cosmosSampler{http: &http.Client{Timeout: 8 * time.Second}})
	registerSampler(KindCardano, &cardanoSampler{http: &http.Client{Timeout: 8 * time.Second}})
	registerSampler(KindStellar, &stellarSampler{http: &http.Client{Timeout: 8 * time.Second}})
}

// ----- Cosmos ----------------------------------------------------------

type tfCoin struct {
	Denom  string `json:"denom"`
	Amount string `json:"amount"`
}

type tfParamsWrap struct {
	Params struct {
		DenomCreationFee         []tfCoin `json:"denom_creation_fee"`
		DenomCreationGasConsume  string   `json:"denom_creation_gas_consume"`
	} `json:"params"`
}

// Per-chain Cosmos gas pricing for the MsgCreateDenom path. The
// `denom_creation_gas_consume` param burns extra gas on top of the
// ~80k baseline gas an MsgCreateDenom tx already consumes; pricing
// these requires the chain's typical gas_price (in base units per gas).
//
// Values calibrated against current Cosmos gas markets (2026-06):
//   Osmosis  base fee oracle returns ~0.03 uosmo/gas
//   Injective standard fee is ~500 inj/gas (1 INJ = 1e18 inj)
//   Neutron  uses ~0.005 untrn/gas typical
//
// Plus the baseline tx gas a normal MsgCreateDenom costs even without
// the consume param.
type cosmosGasModel struct {
	baselineGas    uint64  // gas a MsgCreateDenom tx burns regardless of consume
	gasPriceBase   float64 // base units of native denom per 1 gas
	nativeUnit     string
}

var cosmosGasModels = map[string]cosmosGasModel{
	"osmosis":   {baselineGas: 80_000, gasPriceBase: 0.03, nativeUnit: "uosmo"},
	"injective": {baselineGas: 80_000, gasPriceBase: 5e8, nativeUnit: "inj"},
	"neutron":   {baselineGas: 80_000, gasPriceBase: 0.005, nativeUnit: "untrn"},
}

func (s *cosmosSampler) Sample(ch ChainConfig) (Sample, error) {
	// LCD path per chain. We try a few until one returns 200.
	paths := []string{
		"/osmosis/tokenfactory/v1beta1/params",
		"/injective/tokenfactory/v1beta1/params",
		"/neutron/tokenfactory/v1/params",
	}
	var (
		raw []byte
		err error
	)
	for _, p := range paths {
		resp, e := s.http.Get(ch.RPCURL + p)
		if e != nil {
			err = e
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			continue
		}
		raw, err = io.ReadAll(resp.Body)
		if err == nil {
			break
		}
	}
	if len(raw) == 0 {
		if err == nil {
			err = fmt.Errorf("no tokenfactory params path responded 200")
		}
		return Sample{}, err
	}
	var w tfParamsWrap
	if err := json.Unmarshal(raw, &w); err != nil {
		return Sample{}, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}

	model, hasModel := cosmosGasModels[ch.Slug]
	if !hasModel {
		// Unknown Cosmos chain — fall back to denom_creation_fee only.
		model = cosmosGasModel{nativeUnit: "uosmo"}
	}

	// Protocol fee (often empty list = 0).
	var feeNative float64
	feeUnit := model.nativeUnit
	if len(w.Params.DenomCreationFee) > 0 {
		c := w.Params.DenomCreationFee[0]
		feeNative, err = strconv.ParseFloat(c.Amount, 64)
		if err != nil {
			return Sample{}, fmt.Errorf("parse amount %q: %w", c.Amount, err)
		}
		if c.Denom != "" {
			feeUnit = c.Denom
			if len(feeUnit) > 8 {
				feeUnit = feeUnit[:8]
			}
		}
	}

	// Gas cost: (baseline MsgCreateDenom gas + denom_creation_gas_consume
	// extra burn) × per-chain gas price in base units. This captures the
	// "you still pay something" cost on chains where the protocol fee
	// list is empty.
	extraGas, _ := strconv.ParseFloat(w.Params.DenomCreationGasConsume, 64)
	totalGas := float64(model.baselineGas) + extraGas
	gasCostNative := totalGas * model.gasPriceBase

	total := feeNative + gasCostNative
	return Sample{CostNative: total, NativeUnit: feeUnit, GasUnits: math.NaN()}, nil
}

// ----- Cardano ----------------------------------------------------------

// Cardano native asset minting: cost is the minimum ADA the UTxO
// holding the asset must carry (per Conway/Babbage protocol). The
// canonical formula is:
//
//   minUTxO_lovelace = (utxo_entry_overhead + bundle_size_bytes) × coins_per_utxo_size
//
// where utxo_entry_overhead = 160 bytes (constant) and bundle_size
// for one native asset (32-byte policy hash + short asset name + small
// CBOR overhead) sits around 70 bytes. We also add the on-chain mint
// transaction fee (min_fee_a × tx_size + min_fee_b), approximated as
// ~180k lovelace for a typical ~600-byte mint tx.
//
// Koios /epoch_params returns the live protocol parameters used here.

const (
	cardanoEntryOverheadBytes = 160 // constant overhead for any TxOut
	cardanoBundleBytes        = 70  // policy hash + asset name + CBOR
	cardanoMintTxFeeLovelace  = 180_000
)

type koiosEpochParams []struct {
	// Koios returns numeric fields as JSON numbers in some endpoints and
	// JSON strings in others. Use json.Number for tolerance.
	CoinsPerUtxoSize json.Number `json:"coins_per_utxo_size"`
}

func (s *cardanoSampler) Sample(ch ChainConfig) (Sample, error) {
	resp, err := s.http.Get(ch.RPCURL + "/epoch_params")
	if err != nil {
		return Sample{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Sample{}, err
	}
	dec := json.NewDecoder(bytesNewReader(raw))
	dec.UseNumber()
	var ep koiosEpochParams
	if err := dec.Decode(&ep); err != nil {
		return Sample{}, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}
	if len(ep) == 0 {
		return Sample{}, fmt.Errorf("empty epoch_params response")
	}
	coins, err := ep[0].CoinsPerUtxoSize.Float64()
	if err != nil {
		return Sample{}, fmt.Errorf("parse coins_per_utxo_size %q: %w", ep[0].CoinsPerUtxoSize.String(), err)
	}
	utxoSize := float64(cardanoEntryOverheadBytes + cardanoBundleBytes)
	lovelace := coins*utxoSize + cardanoMintTxFeeLovelace
	return Sample{CostNative: lovelace, NativeUnit: "lovelace", GasUnits: math.NaN()}, nil
}

// ----- Stellar ----------------------------------------------------------

// Stellar custom asset cost is 3 base reserves locked (issuer account +
// distribution account + trustline on distribution) + 2 tx fees
// (create_account + change_trust). base_reserve_in_stroops and
// base_fee_in_stroops are in /ledgers — we use the latest ledger.
// Reusing the issuer as the distribution account is an anti-pattern
// (re-issuance risk), so the bench prices the canonical 2-account
// flow.

type horizonLedgers struct {
	Embedded struct {
		Records []struct {
			BaseFee     uint64 `json:"base_fee_in_stroops"`
			BaseReserve uint64 `json:"base_reserve_in_stroops"`
		} `json:"records"`
	} `json:"_embedded"`
}

func (s *stellarSampler) Sample(ch ChainConfig) (Sample, error) {
	resp, err := s.http.Get(ch.RPCURL + "/ledgers?order=desc&limit=1")
	if err != nil {
		return Sample{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Sample{}, err
	}
	var l horizonLedgers
	if err := json.Unmarshal(raw, &l); err != nil {
		return Sample{}, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}
	if len(l.Embedded.Records) == 0 {
		return Sample{}, fmt.Errorf("empty ledgers response")
	}
	rec := l.Embedded.Records[0]
	// 3 × base_reserve (issuer + distribution + trustline) + 2 × base_fee
	// (create_account + change_trust).
	stroops := 3*rec.BaseReserve + 2*rec.BaseFee
	return Sample{CostNative: float64(stroops), NativeUnit: "stroop", GasUnits: math.NaN()}, nil
}
