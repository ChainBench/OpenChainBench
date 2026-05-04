package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

type MobulaBridgeSimple struct {
	apiKey string
	client *http.Client
}

type MobulaQuoteResp struct {
	Data struct {
		EstimatedAmountOut    string `json:"estimatedAmountOut"`
		EstimatedAmountOutUsd string `json:"estimatedAmountOutUsd"`
		Fees                  struct {
			TotalFeeUsd string `json:"totalFeeUsd"`
		} `json:"fees"`
		Deposit struct {
			Solana struct {
				SerializedTx string `json:"serializedTx"`
			} `json:"solana"`
			EVM struct {
				To    string `json:"to"`
				Data  string `json:"data"`
				Value string `json:"value"`
			} `json:"evm"`
		} `json:"deposit"`
		Steps []struct {
			Type string `json:"type"`
			Tx   struct {
				To    string `json:"to"`
				Data  string `json:"data"`
				Value string `json:"value"`
			} `json:"tx"`
		} `json:"steps"`
	} `json:"data"`
}

type MobulaStatusResp struct {
	Data struct {
		Status string `json:"status"`
	} `json:"data"`
}

func NewMobulaBridgeSimple(apiKey string) *MobulaBridgeSimple {
	return &MobulaBridgeSimple{
		apiKey: apiKey,
		client: &http.Client{Timeout: 45 * time.Second},
	}
}

func (m *MobulaBridgeSimple) GetQuote(params BridgeParams) (*MobulaQuoteResp, error) {
	url := fmt.Sprintf(
		"https://api.mobula.io/api/2/bridge/quote?originChainId=%s&originToken=%s&destinationChainId=%s&destinationToken=%s&amount=%s&walletAddress=%s&senderAddress=%s&apiKey=%s",
		params.FromChain, params.FromToken,
		params.ToChain, params.ToToken,
		strconv.FormatFloat(params.Amount, 'f', -1, 64),
		params.ReceiverAddr, params.SenderAddr,
		m.apiKey,
	)

	resp, err := m.client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var quote MobulaQuoteResp
	if err := json.Unmarshal(body, &quote); err != nil {
		return nil, err
	}

	return &quote, nil
}

func (m *MobulaBridgeSimple) GetStatus(txHash string) (*MobulaStatusResp, error) {
	url := fmt.Sprintf("https://api.mobula.io/api/2/bridge/status/%s", txHash)

	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", m.apiKey)

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var status MobulaStatusResp
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return nil, err
	}

	return &status, nil
}
