-- OpenChainBench /apps — ledger initial
-- Principe : fee_events est immuable et fait autorité. Tout le reste est dérivé
-- et reconstructible. Aucun UPDATE sur fee_events, uniquement des upserts idempotents.

BEGIN;

-- ---------------------------------------------------------------------------
-- Ledger brut. Unités natives, aucune conversion, aucun float.
-- ---------------------------------------------------------------------------
CREATE TABLE fee_events (
  deployment_id  TEXT          NOT NULL,
  event_key      TEXT          NOT NULL,   -- chain:tx_hash:log_index:sub
  beneficiary    TEXT          NOT NULL,
  ts             TIMESTAMPTZ   NOT NULL,   -- timestamp du bloc, UTC
  height         BIGINT        NOT NULL,
  component      TEXT          NOT NULL,
  token          TEXT          NOT NULL,
  amount_raw     NUMERIC(78,0) NOT NULL,   -- entier natif. JAMAIS de float ici.
  decimals       SMALLINT      NOT NULL,
  market         TEXT,
  finality       TEXT          NOT NULL DEFAULT 'provisional',
  source         TEXT          NOT NULL,
  ingested_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  meta           JSONB,
  -- beneficiary fait partie de la clé : un même log émet souvent plusieurs
  -- allocations (feeAmountForPool + feeReceiverAmount dans un PositionFeesCollected).
  PRIMARY KEY (deployment_id, event_key, beneficiary),
  CONSTRAINT finality_valid CHECK (finality IN ('provisional','final'))
);

CREATE INDEX fee_events_ts        ON fee_events (deployment_id, ts);
CREATE INDEX fee_events_height    ON fee_events (deployment_id, height);
CREATE INDEX fee_events_provisional ON fee_events (deployment_id, height)
  WHERE finality = 'provisional';   -- pour le rembobinage après reorg

-- ---------------------------------------------------------------------------
-- Faits dérivés. Jetables : DELETE + recompute est une opération normale.
-- ---------------------------------------------------------------------------
CREATE TABLE fee_facts (
  deployment_id       TEXT        NOT NULL,
  bucket_start        TIMESTAMPTZ NOT NULL,   -- bucket horaire, semi-ouvert [start, start+1h)
  methodology_version INT         NOT NULL,
  component           TEXT        NOT NULL,
  beneficiary         TEXT        NOT NULL,
  token               TEXT        NOT NULL,
  amount_native       NUMERIC     NOT NULL,
  -- Le prix utilisé est stocké. Sans lui, un chiffre USD n'est pas reproductible
  -- et donc pas auditable — c'est tout l'argument du produit.
  price_usd           NUMERIC     NOT NULL,
  price_source        TEXT        NOT NULL,
  price_ts            TIMESTAMPTZ NOT NULL,
  price_confidence    TEXT        NOT NULL DEFAULT 'high',
  amount_usd          NUMERIC     NOT NULL,
  event_count         INT         NOT NULL,
  finality            TEXT        NOT NULL,
  PRIMARY KEY (deployment_id, bucket_start, methodology_version,
               component, beneficiary, token),
  CONSTRAINT price_confidence_valid CHECK (price_confidence IN ('high','medium','low'))
);

CREATE INDEX fee_facts_bucket ON fee_facts (bucket_start, methodology_version);

-- Témoins. Table séparée : jamais jointe aux faits canoniques, jamais sommée avec eux.
CREATE TABLE fee_facts_witness (
  deployment_id  TEXT        NOT NULL,
  bucket_start   TIMESTAMPTZ NOT NULL,
  witness_source TEXT        NOT NULL,
  metric         TEXT        NOT NULL,
  amount_usd     NUMERIC     NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, bucket_start, witness_source, metric)
);

-- ---------------------------------------------------------------------------
-- Émissions. tokens_emitted est brut et séparé du prix : n'importe qui doit
-- pouvoir re-pricer avec sa propre source.
-- ---------------------------------------------------------------------------
CREATE TABLE emissions_daily (
  deployment_id   TEXT        NOT NULL,
  day             DATE        NOT NULL,
  token           TEXT        NOT NULL,
  scope           TEXT        NOT NULL,   -- incentives_only | all_inflation
  tokens_emitted  NUMERIC     NOT NULL,
  price_usd       NUMERIC     NOT NULL,
  price_min_usd   NUMERIC,                -- bande d'incertitude si volatilité > 15%
  price_max_usd   NUMERIC,
  price_method    TEXT        NOT NULL DEFAULT 'daily_twap',
  cost_usd        NUMERIC     NOT NULL,
  PRIMARY KEY (deployment_id, day, token, scope)
);

-- ---------------------------------------------------------------------------
-- Paramètres d'allocation lus on-chain et versionnés dans le temps.
-- C'est la table qui empêche le bug Lido : aucun taux n'est appliqué en dehors
-- de son intervalle de validité observé.
-- ---------------------------------------------------------------------------
CREATE TABLE allocation_params (
  deployment_id  TEXT        NOT NULL,
  param          TEXT        NOT NULL,
  value          NUMERIC     NOT NULL,
  valid_from     TIMESTAMPTZ NOT NULL,
  valid_to       TIMESTAMPTZ,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         TEXT        NOT NULL,    -- contrat/méthode lue, ou URL de gouvernance
  PRIMARY KEY (deployment_id, param, valid_from)
);

-- Interdit deux valeurs simultanées pour un même paramètre.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE allocation_params
  ADD CONSTRAINT allocation_params_no_overlap
  EXCLUDE USING gist (
    deployment_id WITH =,
    param WITH =,
    tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz)) WITH &&
  );

-- ---------------------------------------------------------------------------
-- Curseurs et audit
-- ---------------------------------------------------------------------------
CREATE TABLE collector_cursors (
  deployment_id TEXT        PRIMARY KEY,
  height        BIGINT      NOT NULL,
  block_hash    TEXT,                     -- détection de reorg
  ts            TIMESTAMPTZ NOT NULL,
  finalized     BOOLEAN     NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE methodology_versions (
  slug        TEXT        NOT NULL,
  version     INT         NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary     TEXT        NOT NULL,
  diff_json   JSONB       NOT NULL,       -- alimente /apps/changelog
  PRIMARY KEY (slug, version)
);

CREATE TABLE quarantine (
  deployment_id TEXT        NOT NULL,
  bucket_start  TIMESTAMPTZ NOT NULL,
  reason        TEXT        NOT NULL,
  detail        JSONB,
  issue_url     TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  PRIMARY KEY (deployment_id, bucket_start, reason)
);

-- ---------------------------------------------------------------------------
-- Vue de service du leaderboard. ~40 lignes pour le MVP.
-- Rafraîchie à chaque run du materializer ; la page ne calcule rien.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW fee_facts_windowed AS
SELECT
  f.deployment_id,
  w.window_label,
  f.methodology_version,
  SUM(f.amount_usd) FILTER (WHERE f.component NOT IN
      ('funding_payment','external_bribe','sequencer_revenue','maker_rebate')) AS gross_fees_usd,
  SUM(f.amount_usd) FILTER (WHERE f.beneficiary = 'lp')                        AS lp_revenue_usd,
  SUM(f.amount_usd) FILTER (WHERE f.beneficiary IN ('treasury','insurance_fund')) AS protocol_cut_usd,
  SUM(f.amount_usd) FILTER (WHERE f.beneficiary IN ('token_holder','staker','burn')) AS token_holder_value_usd,
  MIN(f.finality)   AS finality,
  SUM(f.event_count) AS event_count
FROM fee_facts f
CROSS JOIN LATERAL (
  VALUES ('24h', INTERVAL '24 hours'),
         ('7d',  INTERVAL '7 days'),
         ('30d', INTERVAL '30 days')
) AS w(window_label, span)
-- Fenêtre SEMI-OUVERTE. Le `<` de droite est le correctif du bug de
-- double-comptage à la seconde frontière (DefiLlama issue #8656).
WHERE f.bucket_start >= date_trunc('hour', now()) - w.span
  AND f.bucket_start <  date_trunc('hour', now())
GROUP BY f.deployment_id, w.window_label, f.methodology_version;

CREATE UNIQUE INDEX fee_facts_windowed_pk
  ON fee_facts_windowed (deployment_id, window_label, methodology_version);

COMMIT;
