package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

// Solana SPL Token creation cost.
//
// Canonical SPL Token mint account is 82 bytes. A token that's actually
// usable in wallets/DEXs also needs a Metaplex metadata account (679
// bytes, holds name/symbol/URI — equivalent of what ERC20 embeds
// natively in its constructor). Total deploy cost =
//   getMinimumBalanceForRentExemption(82)  // mint rent
// + getMinimumBalanceForRentExemption(165) // ATA for initial holder
// + getMinimumBalanceForRentExemption(679) // Metaplex Token Metadata
// + 5000 lamports/signature × 1 sig
//
// Without the metadata account the headline understates the realistic
// cost ~2.5x — any token visible in Phantom/Jupiter/DEXs requires it,
// and EVM ERC20 deployments embed equivalent info natively in their
// constructor, so omitting it would make the comparison unfair.
//
// Output in lamports; main.go divides by 1e9 to get SOL.

const (
	splMintBytes      = 82
	splATABytes       = 165
	splMetadataBytes  = 679 // Metaplex Token Metadata v1 (post-resize)
	solanaPerSig      = 5000
)

type solanaSampler struct {
	http *http.Client
}

func init() {
	registerSampler(KindSolana, &solanaSampler{http: &http.Client{Timeout: 8 * time.Second}})
}

type solanaRPCReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type solanaRPCResp struct {
	JSONRPC string `json:"jsonrpc"`
	Result  uint64 `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (s *solanaSampler) rentExemption(rpcURL string, bytes int) (uint64, error) {
	body, _ := json.Marshal(solanaRPCReq{
		JSONRPC: "2.0", ID: 1,
		Method: "getMinimumBalanceForRentExemption",
		Params: []any{bytes},
	})
	req, err := http.NewRequest("POST", rpcURL, bytesNewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, err
	}
	var r solanaRPCResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return 0, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}
	if r.Error != nil {
		return 0, fmt.Errorf("rpc error %d: %s", r.Error.Code, r.Error.Message)
	}
	return r.Result, nil
}

func (s *solanaSampler) Sample(ch ChainConfig) (Sample, error) {
	mintRent, err := s.rentExemption(ch.RPCURL, splMintBytes)
	if err != nil {
		return Sample{}, fmt.Errorf("rent(mint): %w", err)
	}
	ataRent, err := s.rentExemption(ch.RPCURL, splATABytes)
	if err != nil {
		return Sample{}, fmt.Errorf("rent(ata): %w", err)
	}
	metaRent, err := s.rentExemption(ch.RPCURL, splMetadataBytes)
	if err != nil {
		return Sample{}, fmt.Errorf("rent(metadata): %w", err)
	}
	total := mintRent + ataRent + metaRent + solanaPerSig
	return Sample{
		CostNative: float64(total),
		NativeUnit: "lamports",
		GasUnits:   math.NaN(),
	}, nil
}

// bytesNewReader is a tiny shim to keep the import surface minimal.
func bytesNewReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
