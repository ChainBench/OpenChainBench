FROM prom/prometheus:v2.49.1

USER root

# Pick which prometheus.yml to bake in (prometheus.yml for prod, prometheus.staging.yml for staging).
ARG PROMETHEUS_CONFIG=prometheus.yml

COPY ${PROMETHEUS_CONFIG} /etc/prometheus/prometheus.yml
COPY alert_rules.yml /etc/prometheus/alert_rules.yml
COPY recording_rules/ /etc/prometheus/recording_rules/
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 9090

# Wrap the prom binary so HL_BENCH_LOCAL_AUTH (and future runtime secrets)
# get written to /etc/prometheus/secrets/* files that prometheus.yml
# references via *_file directives — Prom 2.x doesn't expand ${ENV} in
# arbitrary config fields, so we materialise secrets to disk at start.
ENTRYPOINT ["/entrypoint.sh"]

# --enable-feature=expand-external-labels: lets global.external_labels read ${ENVIRONMENT} from env
# --storage.tsdb.retention.time=7d: this instance is a scrape hub, not an
#   archive. Everything it collects is federated to the VPS Prometheus every
#   30s, the VPS keeps 90d, and the site only ever queries the VPS. The 180d
#   that used to be here was also fiction: measured 2026-10-29, the oldest
#   sample was 24 to 27 days old because the size cap below trips first, while
#   the VPS held the same series past 60 days and had zero metric names this
#   instance did not. So retention here only needs to cover a federation
#   outage, and a week is already generous for that.
# --storage.tsdb.retention.size=2GB: hard ceiling on disk in case cardinality
#   spikes. Prom evicts oldest data on whichever cap (time or size) trips
#   first. Note this does not bound MEMORY: the head block holds the active
#   series whatever the retention, so cardinality is the only lever on RAM.
# --query.lookback-delta=1h: extends Prom's stale window from the 5min
#   default to 1h. Instant queries against gauges that haven't been
#   re-scraped in <1h still return the last value instead of empty.
#   Critical for slow-cadence harnesses (validator-yield, buyback-audit,
#   network-coverage) where bare-metric queries on the OCB site were
#   transiently flipping to "AWAITING" between scrapes.
#
# NOTE: --web.enable-lifecycle was previously disabled because the Railway
# URL was public with no auth, so POST /-/quit would let anyone kill the
# container. We now front Prom with the prom-gateway Caddy service
# (../prom-gateway/), which terminates all public traffic, gates the admin
# + lifecycle paths behind X-Admin-Token, and proxies the read API openly.
# Prom itself binds on 0.0.0.0:9090 so the gateway can reach it over
# Railway internal DNS (prometheus.railway.internal:9090). The public
# domain MUST be removed from this Prom service in Railway settings —
# only the prom-gateway service should have a generated domain.
#
# --web.enable-admin-api: required for POST /api/v1/admin/tsdb/delete_series
#   so the delete-ui can wipe per-bench data. Gated upstream by Caddy.
# --web.enable-lifecycle: required for POST /-/reload and /-/quit. Gated
#   upstream by Caddy.
CMD ["--config.file=/etc/prometheus/prometheus.yml", \
     "--storage.tsdb.path=/prometheus", \
     "--storage.tsdb.retention.time=7d", \
     "--storage.tsdb.retention.size=2GB", \
     "--enable-feature=expand-external-labels", \
     "--query.lookback-delta=1h", \
     "--web.listen-address=0.0.0.0:9090", \
     "--web.enable-admin-api", \
     "--web.enable-lifecycle"]
