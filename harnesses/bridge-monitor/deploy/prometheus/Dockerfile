FROM prom/prometheus:v2.49.1

USER root

# Copy config and alert rules (we're already in prometheus folder as root directory)
COPY prometheus.yml /etc/prometheus/prometheus.yml
COPY alert_rules.yml /etc/prometheus/alert_rules.yml

EXPOSE 9090

# Run as root to avoid permission issues with Railway volumes.
#
# Security: this Prom is reachable from the public internet (used by the
# OpenChainBench site as a federation source). We deliberately do NOT enable:
#   --web.enable-admin-api    -> would expose POST /api/v1/admin/tsdb/delete_series
#                                 (anyone could wipe the dataset)
#   --web.enable-lifecycle    -> would expose POST /-/quitquit and /-/reload
#                                 (anyone could crash or reconfigure it)
# CORS is restricted to the site origin so a browser tab can't issue
# cross-origin admin-style POSTs even if those flags ever creep back in.
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=365d", "--web.cors.origin=^https://openchainbench\\.com$"]
