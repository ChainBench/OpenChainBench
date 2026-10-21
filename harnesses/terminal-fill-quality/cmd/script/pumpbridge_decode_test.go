package main

import (
	"encoding/hex"
	"testing"
)

// Real deposits, captured 2026-10-22. The data is the instruction bytes the
// program emitted; the amount and the user were read independently from the
// transaction's token balance deltas, so these check the decoder against the
// chain rather than against itself.
var pumpDepositFixtures = []struct {
	sig    string
	amount uint64
	user   string
	data   string
}{
	{
		sig:    "uyGyyyv277scbPQncXUxskVWot3ga1JgvyjvVNbNNZ7zWyyyy2ZNqhBw3qvrEGxCAgp6WPBF6XqDRPR2X86fxWZ",
		amount: 2253197,
		user:   "H5N6xY1TTAdPmafRCqcn63qKsqyd39Pnz1EhQevwRn6v",
		data:   "e445a52e51cb9a1d1f8cc689c670de8743d9e4bfc5666483d5de06cf2cb09b58a9fe5f118bb186cc267ae5d644497931eed92ccb1de0ec113d7b188bd6478bbc1ccbc0d4d4d454491d23aba02bdf0aab2c5784a9c82b4913a4baa214160f0ee98d6122000000000050c30000000000007600000007e53fa4a4d93ddaa1897b7e620074ca3db680df40a48b4f9c4214731bb0d64821fe8975e609e9162e1b8b252fbe3bcca23bd3bca679e31217bb04860e3dd517bd047db78a2af8b5db1fd6c83e382586af1bfc558aaeb59c7dbf10fe5908490f5425c540967040e92dbaf180b17b672ca6b3627e5cc9eb3f9902b3000000",
	},
	{
		sig:    "2FXW4CBa9EE9s1HGzZQ34PgPcGptXwg6Xaa9NaFkd2VCPtVxodJz72uyK2khii55GTZdoPJq8PSqvs7HZKc8iCAw",
		amount: 10000000,
		user:   "BjU88YywomJp5dg7DgWFohcPkz3qEYDNt7Uamnw2xKte",
		data:   "e445a52e51cb9a1d1f8cc689c670de8743d9e4bfc5666483d5de06cf2cb09b58a9fe5f118bb186cc267ae5d6444979319f75ee66087ddbdaf715db6b491e093e756e087f4e99abd78ff624cce50539e3048ba45024e7872db7ea9ce5d74a187a809698000000000050c30000000000007400000001bfac72da70be280dfaa1e2f2fae77a450d008051f9f8d6cf2835f3e4cee57f82b7ec6267446f7d76a5559e80b27483e115b4f781c23f35c5d1dfc8e6aa4faa855d3e94e94bb91d4eb077d9f49c826e59829c702a1cf1777c30a9a1e228107b73e5fb9a41a86a28de2727e1cc1c124f67711237a0eadef3b2000000",
	},
	{
		sig:    "3wN5nsDfQDUUF9P4QvfW79kDEutJz7PfRUQMgp6nJVybURhDU4UDEciFngVf68SCjJtsnQX2PzCsPUSoRS2ezF5C",
		amount: 10000000,
		user:   "5YVszx5q13kHwZRTN3JBX4DeUPyA1Nro2KP9zfqGgiqK",
		data:   "e445a52e51cb9a1d1f8cc689c670de8743d9e4bfc5666483d5de06cf2cb09b58a9fe5f118bb186cc267ae5d6444979314380681e27e700a461e430f4da5cc384f444e299df280bc8a5c793be05070bbee547b262541d48b3bc723eba8abd83fe809698000000000050c300000000000076000000e9f5233ddd37c001acdde4d5d60a52b140e1fa1ba168f988845f72147770e7e86e700dc38a6172b59ee12f3ab66529ce185762da7c356e543c06d115aabc1c22753f6cd173330eedfefb80bdce19af3a93dca9d5df5c61a8830e36b55efb336df480afba218cf776c6f8871f83168117ae863850e22850d4512fb3000000",
	},
}

// A real AdminDebit from the same program, which is how users are PAID OUT.
// It carries the same CPI discriminator AND names the same pool in the same
// first 32 bytes as a deposit, so a decoder that checked only the pool would
// read every payout as an inflow. Only the event discriminator separates them.
// This fixture is the reason that check exists.
const pumpAdminDebitFixture = "e445a52e51cb9a1df5184562bce7031b43d9e4bfc5666483d5de06cf2cb09b58a9fe5f118bb186cc267ae5d644497931215450facc8b05fd85ea7f738809723fd7d6635b15f04a04a9af96b31108c7bf87510100000000001581f13bc01aeebb9f767d0312450da17b7b0208b3000000"

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad fixture hex: %v", err)
	}
	return b
}

func TestDecodePumpDepositReadsRealDeposits(t *testing.T) {
	for _, f := range pumpDepositFixtures {
		got, err := decodePumpDeposit(mustHex(t, f.data))
		if err != nil {
			t.Errorf("%s: %v", f.sig[:12], err)
			continue
		}
		if got.Amount != f.amount {
			t.Errorf("%s: amount = %d, want %d (the chain's own balance delta)",
				f.sig[:12], got.Amount, f.amount)
		}
		if got.User != f.user {
			t.Errorf("%s: user = %s, want %s", f.sig[:12], got.User, f.user)
		}
	}
}

// The one that matters. A payout is not a deposit, and the two are far more
// alike than they look.
func TestDecodePumpDepositRefusesAPayout(t *testing.T) {
	raw := mustHex(t, pumpAdminDebitFixture)
	if _, err := decodePumpDeposit(raw); err == nil {
		t.Fatal("AdminDebit decoded as a deposit; inflow would be counted twice")
	}
	// And prove the guard is the discriminator, not an accident of length:
	// the payout really does carry the deposit's CPI discriminator and pool.
	if hexOf(raw[:8]) != pumpCPIDiscriminator {
		t.Error("fixture no longer shares the CPI discriminator; the guard's reason has changed")
	}
	if base58Encode(raw[16:48]) != pumpBridgePool {
		t.Error("fixture no longer names the same pool; the guard's reason has changed")
	}
}

func TestDecodePumpDepositRefusesMalformedInput(t *testing.T) {
	good := mustHex(t, pumpDepositFixtures[0].data)
	cases := []struct {
		name string
		in   []byte
	}{
		{"empty", nil},
		{"shorter than the two discriminators", good[:12]},
		{"right discriminators, body too short", append(append([]byte{}, good[:16]...), good[16:60]...)},
		{"wrong CPI discriminator", append([]byte{0xff}, good[1:]...)},
	}
	for _, c := range cases {
		if _, err := decodePumpDeposit(c.in); err == nil {
			t.Errorf("%s decoded as a deposit", c.name)
		}
	}
}

// A zero amount is not a deposit. Publishing one would drag the measured
// average down with a trade that never happened.
func TestDecodePumpDepositRefusesAZeroAmount(t *testing.T) {
	raw := mustHex(t, pumpDepositFixtures[0].data)
	for i := 16 + pumpEventAmountAt; i < 16+pumpEventAmountAt+8; i++ {
		raw[i] = 0
	}
	if _, err := decodePumpDeposit(raw); err == nil {
		t.Fatal("a zero-amount event decoded as a deposit")
	}
}

// base58Encode is hand-rolled, so it is checked against pubkeys whose encoding
// is known from the chain rather than trusted.
func TestBase58EncodeMatchesKnownPubkeys(t *testing.T) {
	raw := mustHex(t, pumpDepositFixtures[0].data)
	if got := base58Encode(raw[16:48]); got != pumpBridgePool {
		t.Errorf("pool = %s, want %s", got, pumpBridgePool)
	}
	if got := base58Encode(raw[48:80]); got != pumpDepositFixtures[0].user {
		t.Errorf("user = %s, want %s", got, pumpDepositFixtures[0].user)
	}
}
