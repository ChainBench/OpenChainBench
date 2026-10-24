package main

// pump.fun's own bridge, read on Solana.
//
// Until 2026-10-07 pump.fun's cross-chain trades went through Relay and this
// bench read them from Relay's requests feed. pump then made its own bridge the
// default in its app and that feed stopped carrying them, which is why the
// pump-fun-<chain> rows thinned out rather than stopped: the residual Relay
// flow is still there and still published, under the route that carries it.
//
// The EVM side of the bridged trades is the pump-bridge-<chain> rows in
// native.go, which measure the swap the bridge performs. What they cannot see
// is what the bridge CHARGES, because the fee is deducted on the Solana deposit
// before any EVM router spends anything.
//
// This file reads that deposit.
//
// The program is Dsug6JqUcLJaTJCx7ufPREeHjnMakmVEAYSi5oaAEnzK. Its bytecode
// carries the source path programs/pump-bridge/src/lib.rs, and its upgrade
// authority is byte identical to the one controlling pump.fun's bonding curve
// and PumpSwap, so it is pump's.
//
// DELIBERATELY NOT in terminals[].Programs. Adding it there would subscribe the
// existing Solana feed to it for free, and every deposit would then flow into
// the swap parser, which would value a bridge deposit as if it were a swap and
// publish the result. A deposit is not a swap: it has one token leg and its
// counter-leg is on another chain. The cost of a separate path here is a few
// dozen lines; the cost of the shortcut is a wrong number nobody can see.

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
)

// pumpBridgeProgram is the Pump Bridge program on Solana.
const pumpBridgeProgram = "Dsug6JqUcLJaTJCx7ufPREeHjnMakmVEAYSi5oaAEnzK"

// pumpBridgeVault holds the USDC users deposit. Worth about $770k.
const pumpBridgeVault = "2zQ9LNHUVK1GxaHUxbPk2yyBpriSxH4kaioj3SWAwhHU"

// pumpBridgePool is the pool PDA every deposit names, and the first 32 bytes of
// every deposit event. Checking it is how a decoder refuses an event that is
// not a deposit rather than reading 8 arbitrary bytes as an amount.
const pumpBridgePool = "5Zs2Gi9kKvMzzRxmXc5TPEhGBhon2TdMMRAqRx26B4aC"

// The deposit event arrives through Anchor's emit_cpi!: the program invokes
// itself at depth 2 and the event rides in that instruction's data as
//
//	[0:8]    CPI discriminator  e445a52e51cb9a1d
//	[8:16]   event discriminator
//	[16:]    the event body
//
// and in the body, established against seven consecutive deposits of seven
// different amounts on 2026-10-21:
//
//	[0:32]   pool PDA, identical on every one
//	[32:64]  the depositing user
//	[64:80]  the ORDER ID, sixteen bytes (see below)
//	[80:88]  the amount, u64 little endian   <- 7 of 7
//	[88:]    variable length, the encrypted destination params
//
// The body length itself varies (223, 225, 226 bytes seen), which is why the
// amount is read at a fixed offset from the START and nothing is read relative
// to the end. The destination chain and token are encrypted: the program's own
// error string is "encrypted evm params must be 1..=256 bytes".
//
// THE SIXTEEN BYTES AT [64:80] ARE AN ORDER ID, and this file used to record
// them as "sixteen bytes that vary" and conclude that "a deposit cannot be
// paired to the EVM fill it belongs to". The DESTINATION is encrypted, which is
// what that conclusion was really about. The identity of the order is not.
//
// Established on 2026-10-23 from the other direction, where the same field is
// checkable end to end. Both EVM routers emit the order id as topic1 of their
// own event, left-aligned in the word:
//
//	SELL 0xcdad0230…  topic1 = id, topic2 = the trader   535 ids in 535 events
//	BUY  0x84da3a1d…  topic1 = id, topic2 = the trader   107 ids in 107 events
//
// so the id is per-order on the EVM side, never a constant or a bucket. And the
// Solana payout event carries the same sixteen bytes: taking 535 ids off
// Robinhood's router and scanning this program's transactions for the raw bytes
// matched 23 of 23. A 128-bit value does not collide by accident, which is well
// past the specificity floor the Mobula route had to learn when accepting a
// 3-character tail scored 10 of 10 against a strict matcher's 4.
//
// What that buys is the whole reason it is worth decoding: the two legs of one
// order join on an EXACT key read from chain at both ends. No amount tolerance,
// no search window, no ambiguous case. The amount-based pairing this bench used
// before it manufactured a long tail when its window widened, measured the same
// day: four pairs past 300 s appeared within hours of the window going to 1800,
// with nothing at all between 3 s and 300 s, which is what a false partner
// drawn uniformly from a wider window looks like.
//
// The BUY direction is UNPROVEN and is counted rather than assumed. Its event
// has the identical shape, but the overlap test needs more deposits than the
// program's recent traffic contains: 100 signatures held 2 deposits against 182
// payouts, the dust sells dominating. So the deposit id is decoded and its
// match rate is published; nothing rests on it until that rate says it can.
const (
	pumpCPIDiscriminator = "e445a52e51cb9a1d"
	// The deposit event's own discriminator. Checking this is not optional:
	// AdminDebit, which is how users are PAID OUT, rides the same CPI
	// discriminator and names the same pool in the same first 32 bytes. A
	// decoder that checked only the pool would read every payout as a
	// deposit and double the measured inflow.
	pumpDepositDiscriminator = "1f8cc689c670de87"
	pumpEventPoolAt          = 0
	pumpEventUserAt          = 32
	pumpEventOrderAt         = 64
	pumpEventOrderLen        = 16
	pumpEventAmountAt        = 80
	pumpEventMinLen          = 88

	// The payout event, which is how a user is PAID OUT: the Solana leg of a
	// sale that started on an EVM chain. The feed used to skip it, with
	// "a payout or an admin call, which is the norm", and skipping it is why a
	// sale had no measurable destination leg and native.go refused to price one.
	//
	// Its body is a different layout from the deposit's and shorter, read off
	// three consecutive payouts on 2026-10-23:
	//
	//	[0:32]   pool PDA, the same one the deposit names
	//	[32:64]  the user paid out
	//	[64:72]  the amount DELIVERED, u64 little endian, 6 decimals
	//	[72:88]  the order id
	//	[88:96]  an eight-byte field this decoder does not read
	//
	// body length 96, instruction 112. Note the amount and the order id are in
	// the OPPOSITE order from the deposit, so the two layouts cannot share
	// offsets and a decoder that reused them would read an id as an amount.
	//
	// The delivered amount was checked against a second, independent reading:
	// the user's own USDC balance change across the transaction, from
	// pre/postTokenBalances. Three payouts, three agreements to the unit
	// (135031, 135178, 135055 against 0.135031, 0.135178, 0.135055). That
	// matters more than the offset being plausible: an 8-byte window at a fixed
	// offset will always decode to SOME number.
	pumpPayoutDiscriminator = "f5184562bce7031b"
	pumpPayoutAmountAt      = 64
	pumpPayoutOrderAt       = 72
	pumpPayoutMinLen        = 88
)

var errNotPumpDeposit = errors.New("not a pump bridge deposit event")
var errNotPumpPayout = errors.New("not a pump bridge payout event")

// pumpDeposit is what one deposit states about itself. The destination is
// absent on purpose: it is encrypted on chain and guessing it would be
// invention. The order id is NOT encrypted and is carried here, because it is
// what lets the EVM side find this exact deposit instead of one that merely
// has the same amount.
type pumpDeposit struct {
	User   string // the depositing wallet, base58
	Amount uint64 // USDC in smallest units, 6 decimals
	Order  string // the order id, 32 hex characters; "" when the body is short
}

// pumpPayout is one delivery to a user: the Solana leg of a sale.
//
// Amount is READ, not derived. That is the whole point of decoding this event:
// the buy direction recovers what the user committed by inverting pump's
// schedule, and the sale direction has no established mirror for that, so
// native.go refused to price a sale at all. With the payout the proceeds are a
// measurement, and nothing has to be assumed about where the cut falls.
type pumpPayout struct {
	User   string // the wallet paid out, base58
	Amount uint64 // delivered, smallest units, 6 decimals
	Order  string // the order id, 32 hex characters
}

// decodePumpDeposit reads one inner instruction's data as a deposit event.
//
// It returns errNotPumpDeposit for anything that is not one, which includes
// every other instruction the program emits (AdminDebit pays users out,
// Withdraw, CloseReceipt and the admin calls). Being strict here is the point:
// this program's traffic is mostly payouts, so a decoder that accepted whatever
// it was handed would publish payouts as deposits.
func decodePumpDeposit(data []byte) (pumpDeposit, error) {
	if len(data) < 16 {
		return pumpDeposit{}, errNotPumpDeposit
	}
	if hexOf(data[:8]) != pumpCPIDiscriminator {
		return pumpDeposit{}, errNotPumpDeposit
	}
	if hexOf(data[8:16]) != pumpDepositDiscriminator {
		return pumpDeposit{}, errNotPumpDeposit
	}
	body := data[16:]
	if len(body) < pumpEventMinLen {
		return pumpDeposit{}, errNotPumpDeposit
	}
	if base58Encode(body[pumpEventPoolAt:pumpEventPoolAt+32]) != pumpBridgePool {
		return pumpDeposit{}, errNotPumpDeposit
	}
	amount := binary.LittleEndian.Uint64(body[pumpEventAmountAt : pumpEventAmountAt+8])
	if amount == 0 {
		return pumpDeposit{}, errNotPumpDeposit
	}
	return pumpDeposit{
		User:   base58Encode(body[pumpEventUserAt : pumpEventUserAt+32]),
		Amount: amount,
		Order:  hexOf(body[pumpEventOrderAt : pumpEventOrderAt+pumpEventOrderLen]),
	}, nil
}

// decodePumpPayout reads one inner instruction's data as a payout event.
//
// Strict for the same reason decodePumpDeposit is, and one step more so: both
// events ride the same CPI discriminator and name the same pool in the same
// first 32 bytes, so the EVENT discriminator is the only thing separating them
// and the two bodies put the amount and the order id at swapped offsets. A
// decoder that checked the pool alone would read each event as the other and
// publish an order id as a delivered amount.
func decodePumpPayout(data []byte) (pumpPayout, error) {
	if len(data) < 16 {
		return pumpPayout{}, errNotPumpPayout
	}
	if hexOf(data[:8]) != pumpCPIDiscriminator {
		return pumpPayout{}, errNotPumpPayout
	}
	if hexOf(data[8:16]) != pumpPayoutDiscriminator {
		return pumpPayout{}, errNotPumpPayout
	}
	body := data[16:]
	if len(body) < pumpPayoutMinLen {
		return pumpPayout{}, errNotPumpPayout
	}
	if base58Encode(body[pumpEventPoolAt:pumpEventPoolAt+32]) != pumpBridgePool {
		return pumpPayout{}, errNotPumpPayout
	}
	amount := binary.LittleEndian.Uint64(body[pumpPayoutAmountAt : pumpPayoutAmountAt+8])
	if amount == 0 {
		return pumpPayout{}, errNotPumpPayout
	}
	order := hexOf(body[pumpPayoutOrderAt : pumpPayoutOrderAt+pumpEventOrderLen])
	// An all-zero id is not an id. It would join every EVM leg whose own id
	// failed to decode to this one payout, which is worse than not joining.
	if order == "00000000000000000000000000000000" {
		return pumpPayout{}, errNotPumpPayout
	}
	return pumpPayout{
		User:   base58Encode(body[pumpEventUserAt : pumpEventUserAt+32]),
		Amount: amount,
		Order:  order,
	}, nil
}

// decodePumpDepositB64 is the same from the base64 an RPC returns.
func decodePumpDepositB64(s string) (pumpDeposit, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return pumpDeposit{}, errNotPumpDeposit
	}
	return decodePumpDeposit(raw)
}

const hexDigits = "0123456789abcdef"

func hexOf(b []byte) string {
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, hexDigits[c>>4], hexDigits[c&0x0f])
	}
	return string(out)
}
