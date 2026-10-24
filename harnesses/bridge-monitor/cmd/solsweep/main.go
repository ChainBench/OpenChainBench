package main

// Move every Solana position off the execution wallet onto a replacement.
//
// Written for the 2026-10-21 key rotation. The EVM side of that rotation used
// cmd/sendgas with its new --token mode; Solana needed its own tool because
// an SPL transfer has to create the recipient's associated token account and
// native SOL cannot be swept to zero.
//
// The SPL path is the one cmd/monitor already uses in TransferSPL
// (nearintents_exec.go): CreateIdempotent on the destination ATA, then
// TransferChecked, both in one transaction. Reused rather than rewritten,
// because it has moved real funds.
//
// Order: tokens first, native last. Every SPL transfer pays a fee in SOL, and
// an emptied account cannot pay for anything. A reserve stays behind so the
// account remains rent-exempt and can still sign.
//
// Dry run unless --yes.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	ata "github.com/gagliardetto/solana-go/programs/associated-token-account"
	"github.com/gagliardetto/solana-go/programs/system"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"
)

// 0.004 SOL. Comfortably above the rent-exempt minimum for a system account
// plus several signatures, and far below the value of the account staying
// able to transact at all.
const reserveLamports = uint64(4_000_000)

type position struct {
	mint     solana.PublicKey
	ata      solana.PublicKey
	raw      uint64
	decimals uint8
	ui       string
}

func main() {
	toFlag := flag.String("to", "", "destination Solana address")
	yes := flag.Bool("yes", false, "broadcast; without it the tool only prints the plan")
	flag.Parse()

	if *toFlag == "" {
		die("--to is required")
	}
	dest, err := solana.PublicKeyFromBase58(*toFlag)
	if err != nil {
		die(fmt.Sprintf("--to is not a valid address: %v", err))
	}
	if dest.IsZero() {
		die("--to is the zero address")
	}

	raw := strings.TrimSpace(os.Getenv("WALLET_SOL_PRIVATE_KEY"))
	if raw == "" {
		die("WALLET_SOL_PRIVATE_KEY is not set")
	}
	key, err := solana.PrivateKeyFromBase58(raw)
	if err != nil {
		die(fmt.Sprintf("WALLET_SOL_PRIVATE_KEY does not parse: %v", err))
	}
	owner := key.PublicKey()
	if owner.Equals(dest) {
		die("source and destination are the same account")
	}

	endpoint := strings.TrimSpace(os.Getenv("SOLANA_RPC"))
	if endpoint == "" {
		endpoint = rpc.MainNetBeta_RPC
	}
	cl := rpc.New(endpoint)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	fmt.Printf("from %s\nto   %s\n\n", owner, dest)

	positions, err := listPositions(ctx, cl, owner)
	if err != nil {
		die(fmt.Sprintf("list token accounts: %v", err))
	}
	if len(positions) == 0 {
		fmt.Println("no non-empty token accounts")
	}
	for _, p := range positions {
		fmt.Printf("  SPL %s  %s (raw %d, decimals %d)\n", p.mint, p.ui, p.raw, p.decimals)
	}

	bal, err := cl.GetBalance(ctx, owner, rpc.CommitmentFinalized)
	if err != nil {
		die(fmt.Sprintf("native balance: %v", err))
	}
	var nativeSend uint64
	if bal.Value > reserveLamports {
		nativeSend = bal.Value - reserveLamports
	}
	fmt.Printf("  SOL native %.9f of %.9f, leaving %.9f as reserve\n\n",
		float64(nativeSend)/1e9, float64(bal.Value)/1e9, float64(reserveLamports)/1e9)

	if !*yes {
		fmt.Println("dry run, pass --yes to broadcast")
		return
	}

	for _, p := range positions {
		sig, err := transferSPL(ctx, cl, key, owner, dest, p)
		if err != nil {
			fmt.Printf("  !! SPL %s failed: %v\n", p.mint, err)
			continue
		}
		fmt.Printf("  sent SPL %s: %s\n", p.mint, sig)
		time.Sleep(4 * time.Second)
	}

	// Re-read: the SPL transfers above each burned a fee and paid ATA rent.
	bal, err = cl.GetBalance(ctx, owner, rpc.CommitmentFinalized)
	if err != nil {
		die(fmt.Sprintf("native balance after SPL legs: %v", err))
	}
	if bal.Value <= reserveLamports {
		fmt.Printf("  native %.9f SOL is at or below the reserve, leaving it\n",
			float64(bal.Value)/1e9)
		return
	}
	sig, err := transferSOL(ctx, cl, key, owner, dest, bal.Value-reserveLamports)
	if err != nil {
		die(fmt.Sprintf("native transfer: %v", err))
	}
	fmt.Printf("  sent %.9f SOL: %s\n", float64(bal.Value-reserveLamports)/1e9, sig)
}

// listPositions reads every SPL account the owner holds, so a mint nobody
// wrote down by hand is still swept.
func listPositions(ctx context.Context, cl *rpc.Client, owner solana.PublicKey) ([]position, error) {
	prog := solana.TokenProgramID
	out, err := cl.GetTokenAccountsByOwner(ctx, owner,
		&rpc.GetTokenAccountsConfig{ProgramId: &prog},
		&rpc.GetTokenAccountsOpts{Encoding: solana.EncodingJSONParsed})
	if err != nil {
		return nil, err
	}
	var positions []position
	for _, acc := range out.Value {
		var parsed struct {
			Parsed struct {
				Info struct {
					Mint        string `json:"mint"`
					TokenAmount struct {
						Amount         string `json:"amount"`
						Decimals       uint8  `json:"decimals"`
						UIAmountString string `json:"uiAmountString"`
					} `json:"tokenAmount"`
				} `json:"info"`
			} `json:"parsed"`
		}
		if err := json.Unmarshal(acc.Account.Data.GetRawJSON(), &parsed); err != nil {
			return nil, fmt.Errorf("decode %s: %w", acc.Pubkey, err)
		}
		info := parsed.Parsed.Info
		var rawAmt uint64
		if _, err := fmt.Sscanf(info.TokenAmount.Amount, "%d", &rawAmt); err != nil {
			return nil, fmt.Errorf("amount %q on %s: %w", info.TokenAmount.Amount, acc.Pubkey, err)
		}
		if rawAmt == 0 {
			continue
		}
		mint, err := solana.PublicKeyFromBase58(info.Mint)
		if err != nil {
			return nil, fmt.Errorf("mint %q: %w", info.Mint, err)
		}
		positions = append(positions, position{
			mint:     mint,
			ata:      acc.Pubkey,
			raw:      rawAmt,
			decimals: info.TokenAmount.Decimals,
			ui:       info.TokenAmount.UIAmountString,
		})
	}
	return positions, nil
}

// transferSPL mirrors TxExecutor.TransferSPL in cmd/monitor: create the
// destination ATA idempotently, then TransferChecked, in one transaction.
func transferSPL(ctx context.Context, cl *rpc.Client, key solana.PrivateKey,
	owner, destOwner solana.PublicKey, p position) (string, error) {
	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, p.mint)
	if err != nil {
		return "", fmt.Errorf("source ATA: %w", err)
	}
	// The listing gives the account directly; if it disagrees with the
	// derived address the token sits in a non-canonical account and this
	// tool is the wrong one for it.
	if !sourceATA.Equals(p.ata) {
		return "", fmt.Errorf("token account %s is not the canonical ATA %s", p.ata, sourceATA)
	}
	destATA, _, err := solana.FindAssociatedTokenAddress(destOwner, p.mint)
	if err != nil {
		return "", fmt.Errorf("dest ATA: %w", err)
	}

	createIx := ata.NewCreateIdempotentInstruction(owner, destOwner, p.mint).Build()
	transferIx := token.NewTransferCheckedInstruction(
		p.raw, p.decimals, sourceATA, p.mint, destATA, owner, nil).Build()

	return signAndSend(ctx, cl, key, owner, []solana.Instruction{createIx, transferIx})
}

func transferSOL(ctx context.Context, cl *rpc.Client, key solana.PrivateKey,
	owner, dest solana.PublicKey, lamports uint64) (string, error) {
	ix := system.NewTransferInstruction(lamports, owner, dest).Build()
	return signAndSend(ctx, cl, key, owner, []solana.Instruction{ix})
}

func signAndSend(ctx context.Context, cl *rpc.Client, key solana.PrivateKey,
	owner solana.PublicKey, ixs []solana.Instruction) (string, error) {
	recent, err := cl.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", fmt.Errorf("blockhash: %w", err)
	}
	tx, err := solana.NewTransaction(ixs, recent.Value.Blockhash, solana.TransactionPayer(owner))
	if err != nil {
		return "", fmt.Errorf("build: %w", err)
	}
	if _, err := tx.Sign(func(k solana.PublicKey) *solana.PrivateKey {
		if k.Equals(owner) {
			return &key
		}
		return nil
	}); err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}
	sig, err := cl.SendTransaction(ctx, tx)
	if err != nil {
		if sig != (solana.Signature{}) {
			// Report the signature: the transaction may still land, and a
			// retry on a "failed" send is how a double spend happens.
			return sig.String(), fmt.Errorf("send (may still be accepted, sig %s): %w", sig, err)
		}
		return "", fmt.Errorf("send: %w", err)
	}
	return sig.String(), nil
}

func die(m string) {
	fmt.Fprintln(os.Stderr, "error: "+m)
	os.Exit(1)
}
