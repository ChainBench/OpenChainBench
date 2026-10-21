package main

// pump.fun's own bridge, read on Solana.
//
// Until 2026-10-07 pump.fun's cross-chain trades went through Relay and this
// bench read them from Relay's requests feed. pump then made its own bridge the
// default in its app and that feed stopped carrying them. The EVM side of those
// trades is picked up by the evmTerminal rows (pump-fun-bnb and friends in
// native.go), which measure the swap the bridge performs. What they cannot see
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
//	[64:80]  sixteen bytes that vary
//	[80:88]  the amount, u64 little endian   <- 7 of 7
//	[88:]    variable length, the encrypted destination params
//
// The body length itself varies (223, 225, 226 bytes seen), which is why the
// amount is read at a fixed offset from the START and nothing is read relative
// to the end. The destination chain and token are encrypted: the program's own
// error string is "encrypted evm params must be 1..=256 bytes". So a deposit
// cannot be paired to the EVM fill it belongs to, and this decoder does not
// pretend otherwise; it reports what the deposit itself states.
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
	pumpEventAmountAt        = 80
	pumpEventMinLen          = 88
)

var errNotPumpDeposit = errors.New("not a pump bridge deposit event")

// pumpDeposit is what one deposit states about itself. The destination is
// absent on purpose: it is encrypted on chain and guessing it would be
// invention.
type pumpDeposit struct {
	User   string // the depositing wallet, base58
	Amount uint64 // USDC in smallest units, 6 decimals
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
