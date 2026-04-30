FROM prom/prometheus:v2.49.1

USER root

# Copy config and alert rules (we're already in prometheus folder as root directory)
COPY prometheus.yml /etc/prometheus/prometheus.yml
COPY alert_rules.yml /etc/prometheus/alert_rules.yml

EXPOSE 9090

# Run as root to avoid permission issues with Railway volumes
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=365d", "--web.enable-lifecycle", "--web.enable-admin-api"]
