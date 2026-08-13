-- OCB Bench 203: Memecoin Platform Fees (Dune Trino SQL)
-- Monitors known fee wallets for native SOL, USDC, and WSOL inflows.
-- Key: native SOL uses address column, SPL tokens use token_balance_owner column.
--
-- Columns: platform, usdc_fees_24h, wsol_fees_24h, sol_fees_24h, data_freshness
-- data_freshness = MAX(block_time) across all matched rows; alerts if table lags
-- and the nominal 24h window silently shrinks (e.g. table only refreshed 20h ago).

WITH

wallet_platform AS (
  SELECT address, platform FROM (VALUES
    ('BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT','gmgn'),
    ('7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA','gmgn'),
    ('HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3','gmgn'),
    ('ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy','gmgn'),
    ('DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9','gmgn'),
    ('3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK','gmgn'),
    ('DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx','gmgn'),
    ('dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ','gmgn'),
    ('6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn','gmgn'),
    ('7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj','axiom'),
    ('4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S','axiom'),
    ('CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ','axiom'),
    ('AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW','axiom'),
    ('7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws','axiom'),
    ('9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP','axiom'),
    ('DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy','axiom'),
    ('4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd','axiom'),
    ('76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf','axiom'),
    ('H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK','axiom'),
    ('8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm','axiom'),
    ('4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz','axiom'),
    ('8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb','axiom'),
    ('86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG','axiom'),
    ('DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM','axiom'),
    ('5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB','axiom'),
    ('DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF','axiom'),
    ('Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9','axiom'),
    ('846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8','axiom'),
    ('5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg','axiom'),
    ('HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq','fomo'),
    ('9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco','trojan'),
    ('92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH','trojan'),
    ('2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ','trojan'),
    ('65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH','trojan'),
    ('BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp','trojan'),
    ('8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn','trojan'),
    ('AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH','photon'),
    ('MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36','maestro'),
    ('FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN','maestro'),
    ('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM','pump-fun'),
    ('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV','pump-fun'),
    ('FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz','pump-fun'),
    ('7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX','pump-fun'),
    ('AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY','pump-fun'),
    ('9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz','pump-fun'),
    ('G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP','pump-fun'),
    ('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ','pump-fun'),
    ('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS','pump-fun')
  ) AS t(address, platform)
),

native_sol AS (
  SELECT wp.platform, CAST(a.post_balance - a.pre_balance AS DOUBLE) / 1e9 AS inflow, a.block_time
  FROM solana.account_activity a
  JOIN wallet_platform wp ON a.address = wp.address
  WHERE a.block_time >= NOW() - INTERVAL '1' DAY
    AND a.token_mint_address IS NULL
    AND a.post_balance > a.pre_balance
),

usdc_inflows AS (
  SELECT wp.platform, GREATEST(a.post_token_balance - a.pre_token_balance, 0) / 1e6 AS inflow, a.block_time
  FROM solana.account_activity a
  JOIN wallet_platform wp ON a.token_balance_owner = wp.address
  WHERE a.block_time >= NOW() - INTERVAL '1' DAY
    AND a.token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    AND a.post_token_balance > a.pre_token_balance
),

wsol_inflows AS (
  SELECT wp.platform, GREATEST(a.post_token_balance - a.pre_token_balance, 0) / 1e9 AS inflow, a.block_time
  FROM solana.account_activity a
  JOIN wallet_platform wp ON a.token_balance_owner = wp.address
  WHERE a.block_time >= NOW() - INTERVAL '1' DAY
    AND a.token_mint_address = 'So11111111111111111111111111111111111111112'
    AND a.post_token_balance > a.pre_token_balance
),

combined AS (
  SELECT platform, 0.0 AS usdc_inflow, 0.0 AS wsol_inflow, inflow AS sol_inflow, block_time FROM native_sol
  UNION ALL
  SELECT platform, inflow, 0.0, 0.0, block_time FROM usdc_inflows
  UNION ALL
  SELECT platform, 0.0, inflow, 0.0, block_time FROM wsol_inflows
)

SELECT
  platform,
  COALESCE(SUM(usdc_inflow), 0) AS usdc_fees_24h,
  COALESCE(SUM(wsol_inflow), 0) AS wsol_fees_24h,
  COALESCE(SUM(sol_inflow), 0)  AS sol_fees_24h,
  MAX(block_time)                AS data_freshness
FROM combined
GROUP BY platform
ORDER BY platform
