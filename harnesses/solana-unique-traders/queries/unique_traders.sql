-- Unique daily traders by Solana trading platform
-- Source: pump_fun_solana.trades (pump.fun) + solana.account_activity joined with solana.transactions (all others)
-- Attribution: fee wallet presence in transaction account keys
-- Window: rolling 24 hours
-- Used by: OpenChainBench Bench 207 (solana-unique-traders)

WITH pump_fun AS (
  SELECT
    'pump-fun' AS platform,
    COUNT(DISTINCT trader_id) AS unique_traders_24h
  FROM pump_fun_solana.trades
  WHERE block_time >= NOW() - INTERVAL '1' DAY
),

fee_activity AS (
  SELECT
    CASE
      WHEN address IN (
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
      WHEN address IN (
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
      WHEN address IN (
        'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq'
      ) THEN 'fomo'
      WHEN address IN (
        '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco',
        '92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH',
        '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ',
        '65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH',
        'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp',
        '8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn'
      ) THEN 'trojan'
      WHEN address IN (
        'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH'
      ) THEN 'photon'
      WHEN address IN (
        'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36',
        'FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN'
      ) THEN 'maestro'
    END AS platform,
    tx_id
  FROM solana.account_activity
  WHERE block_time >= NOW() - INTERVAL '1' DAY
    AND address IN (
      -- GMGN (9 wallets)
      'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT',
      '7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA',
      'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3',
      'ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy',
      'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9',
      '3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK',
      'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx',
      'dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ',
      '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn',
      -- AXIOM (20 wallets)
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
      '5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg',
      -- FOMO (1 wallet, USDC ATA)
      'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq',
      -- TROJAN (6 wallets)
      '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco',
      '92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH',
      '2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ',
      '65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH',
      'BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp',
      '8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn',
      -- PHOTON (1 wallet)
      'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH',
      -- MAESTRO (2 wallets)
      'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36',
      'FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN'
    )
),

fee_with_signer AS (
  SELECT
    fa.platform,
    t.fee_payer
  FROM fee_activity fa
  JOIN solana.transactions t ON t.id = fa.tx_id
  WHERE t.success = true
    AND fa.platform IS NOT NULL
),

fee_counts AS (
  SELECT
    platform,
    COUNT(DISTINCT fee_payer) AS unique_traders_24h
  FROM fee_with_signer
  GROUP BY platform
)

SELECT platform, unique_traders_24h FROM pump_fun
UNION ALL
SELECT platform, unique_traders_24h FROM fee_counts
ORDER BY unique_traders_24h DESC
