package main

import (
	"errors"
	"testing"
)

func TestPolymarketBookMid(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		book    polymarketBook
		wantMid float64
		wantErr error
	}{
		{
			name: "top of book",
			book: polymarketBook{
				Bids: [][2]string{{"1685.1", "22"}, {"1685.0", "13"}},
				Asks: [][2]string{{"1685.2", "26"}, {"1685.3", "10"}},
			},
			wantMid: 1685.15,
		},
		{
			name:    "no bids",
			book:    polymarketBook{Asks: [][2]string{{"1685.2", "26"}}},
			wantErr: errPolymarketBadTop,
		},
		{
			name:    "no asks",
			book:    polymarketBook{Bids: [][2]string{{"1685.1", "22"}}},
			wantErr: errPolymarketBadTop,
		},
		{
			name: "crossed",
			book: polymarketBook{
				Bids: [][2]string{{"1685.3", "1"}},
				Asks: [][2]string{{"1685.2", "1"}},
			},
			wantErr: errPolymarketBadTop,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			mid, err := polymarketBookMid(tc.book)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if mid != tc.wantMid {
				t.Errorf("mid = %v, want %v", mid, tc.wantMid)
			}
		})
	}
}
