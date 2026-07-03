package main

// types.go — shared data types for the Relay.link revenue harness.
//
// Mirrors only the fields we actually consume from
// GET https://api.relay.link/requests. We intentionally keep the
// payload struct minimal (rather than mapping the full API) so that
// upstream schema additions don't break unmarshalling.

// RelayPage is one page of /requests.
type RelayPage struct {
	Requests     []RelayRequest `json:"requests"`
	Continuation string         `json:"continuation"`
}

// RelayRequest is a single cross-chain swap as returned by Relay.
type RelayRequest struct {
	ID        string       `json:"id"`
	Status    string       `json:"status"`     // "success", "pending", "failure", ...
	CreatedAt string       `json:"createdAt"`  // RFC3339
	UpdatedAt string       `json:"updatedAt"`  // RFC3339
	Data      RelayReqData `json:"data"`
}

// RelayReqData carries the cross-chain payload Relay exposes per swap.
type RelayReqData struct {
	Metadata    RelayMetadata `json:"metadata"`
	InTxs       []RelayTx     `json:"inTxs"`
	OutTxs      []RelayTx     `json:"outTxs"`
	AppFees     []RelayAppFee `json:"appFees"`
	// FeeCurrency is a symbol-string ("usdc", "eth", …), NOT a RelayCurrency
	// struct as one might guess. Per-appFee pricing uses RelayAppFee.Currency
	// which IS a struct; this field is informational at the data level only.
	FeeCurrency string `json:"feeCurrency"`
}

// RelayMetadata.currencyIn / currencyOut carry the user-perceived swap
// (debited / credited). amount is decimal-formatted string.
type RelayMetadata struct {
	CurrencyIn  RelayAmount `json:"currencyIn"`
	CurrencyOut RelayAmount `json:"currencyOut"`
}

type RelayAmount struct {
	Currency  RelayCurrency `json:"currency"`
	Amount    string        `json:"amount"`    // raw smallest unit (wei/lamports)
	AmountUSD string        `json:"amountUsd"` // sometimes pre-priced by Relay; treat as hint, recompute when missing
}

type RelayCurrency struct {
	ChainID  int64  `json:"chainId"`
	Address  string `json:"address"`
	Symbol   string `json:"symbol"`
	Name     string `json:"name"`
	Decimals int    `json:"decimals"`
}

// RelayTx represents one inbound/outbound on-chain tx referenced by the swap.
// `fee` is the gas paid in the chain's native token, raw smallest unit.
type RelayTx struct {
	Hash    string `json:"hash"`
	ChainID int64  `json:"chainId"`
	Fee     string `json:"fee"`
}

// RelayAppFee is an external integrator/protocol fee (Relay routes it
// onchain on behalf of the integrator). Currency frequently differs
// from the swap currency — typically USDC.
type RelayAppFee struct {
	Recipient string        `json:"recipient"`
	Amount    string        `json:"amount"`
	Currency  RelayCurrency `json:"currency"`
}

// Swap is our internal, denormalized view used for storage + metrics.
type Swap struct {
	ID         string
	CreatedAt  int64 // unix sec
	Status     string
	VolumeUSD  float64
	GasUSD     float64
	AppFeesUSD float64
	MarginUSD  float64
	ChainIn    int64
	ChainOut   int64
	Priced     bool
}
