-- OCB Bench 203: Memecoin Platform Fees (Dune Trino SQL)
-- Queries known fee wallets for USDC and WSOL inflows, plus pump-fun bonding curve
-- native SOL receipts. Returns raw token amounts; the harness converts to USD.
--
-- Columns returned: platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h

WITH

-- USDC and WSOL token inflows to known fee wallets
token_fees AS (
  SELECT
    CASE
      WHEN token_balance_owner IN (
        'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT',
        '7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA',
        'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3',
        'ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy',
        'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9',
        '3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK',
        'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx',
        'dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ',
        '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn'
      ) THEN 'gmgn'
      WHEN token_balance_owner IN (
        '7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj',
        '4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S',
        'CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ',
        'AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW',
        '7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws',
        '9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP',
        'DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy',
        '4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd',
        '76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf',
        'H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK',
        '8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm',
        '4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz',
        '8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb',
        '86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG',
        'DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM',
        '5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB',
        'DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF',
        'Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9',
        '846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8',
        '5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg'
      ) THEN 'axiom'
      WHEN token_balance_owner IN (
        'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq'
      ) THEN 'fomo'
      WHEN token_balance_owner IN (
        '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco',
        '92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH',
        '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ',
        '65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH',
        'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp',
        '8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn'
      ) THEN 'trojan'
      WHEN token_balance_owner IN (
        'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH'
      ) THEN 'photon'
      WHEN token_balance_owner IN (
        'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36',
        'FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN'
      ) THEN 'maestro'
    END AS platform,
    token_mint_address,
    GREATEST(post_token_balance - pre_token_balance, 0) AS inflow
  FROM solana.account_activity
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND token_mint_address IN (
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  -- USDC
      'So11111111111111111111111111111111111111112'         -- WSOL
    )
    AND post_token_balance > pre_token_balance
    AND token_balance_owner IN (
      -- gmgn
      'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT','7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA',
      'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3','ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy',
      'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9','3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK',
      'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx','dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ',
      '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn',
      -- axiom
      '7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj','4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S',
      'CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ','AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW',
      '7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws','9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP',
      'DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy','4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd',
      '76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf','H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK',
      '8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm','4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz',
      '8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb','86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG',
      'DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM','5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB',
      'DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF','Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9',
      '846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8','5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg',
      -- fomo
      'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq',
      -- trojan
      '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco','92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH',
      '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ','65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH',
      'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp','8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn',
      -- photon
      'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH',
      -- maestro
      'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36','FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN'
    )
),

-- Aggregate USDC and WSOL separately, per platform
token_agg AS (
  SELECT
    platform,
    SUM(CASE WHEN token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN inflow ELSE 0 END) / 1e6 AS usdc_fees_24h,
    SUM(CASE WHEN token_mint_address = 'So11111111111111111111111111111111111111112' THEN inflow ELSE 0 END) / 1e9 AS wsol_fees_24h,
    0.0 AS sol_fees_24h
  FROM token_fees
  WHERE platform IS NOT NULL
  GROUP BY platform
),

-- pump-fun bonding curve: sum 1% fee from pump_fun_solana.trades (buys only)
pumpfun_trade_fees AS (
  SELECT
    'pump-fun' AS platform,
    0.0 AS usdc_fees_24h,
    0.0 AS wsol_fees_24h,
    SUM(sol_amount * 0.01) AS sol_fees_24h
  FROM pump_fun_solana.trades
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND tx_type = 'buy'
),

-- pump-fun bonding curve fee wallet native SOL receipts (cross-check / supplement)
pumpfun_wallet_fees AS (
  SELECT
    'pump-fun' AS platform,
    0.0 AS usdc_fees_24h,
    0.0 AS wsol_fees_24h,
    SUM(CAST(post_balance - pre_balance AS DOUBLE)) / 1e9 AS sol_fees_24h
  FROM solana.account_activity
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND address IN (
      'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
      '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
      'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
      '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
      'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
      '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
      'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
      '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
      'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS'
    )
    AND post_balance > pre_balance
    AND token_mint_address IS NULL  -- native SOL only
)

SELECT platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h FROM token_agg
UNION ALL
SELECT platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h FROM pumpfun_trade_fees
UNION ALL
SELECT platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h FROM pumpfun_wallet_fees
ORDER BY platform
