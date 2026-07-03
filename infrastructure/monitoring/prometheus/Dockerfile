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
# --storage.tsdb.retention.time=180d: keep historical samples 6 months so
#   sponsor pitches + bench pages can show multi-month trends. Default is
#   15d which is too short for our use case.
# --storage.tsdb.retention.size=10GB: hard ceiling on disk to prevent the
#   Railway volume filling up if cardinality spikes. With ~500 active
#   series at 10s scrape the projected footprint is ~2-3 GB over 180d, so
#   10 GB is a comfortable safety margin. Prom evicts oldest data on
#   whichever cap (time or size) trips first.
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
     "--storage.tsdb.retention.time=180d", \
     "--storage.tsdb.retention.size=10GB", \
     "--enable-feature=expand-external-labels", \
     "--query.lookback-delta=1h", \
     "--web.listen-address=0.0.0.0:9090", \
     "--web.enable-admin-api", \
     "--web.enable-lifecycle"]
