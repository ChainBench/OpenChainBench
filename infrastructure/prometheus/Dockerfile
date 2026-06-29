FROM prom/prometheus:latest

USER root

COPY prometheus.yml /etc/prometheus/prometheus.yml

# Long retention so old benchmarks remain queryable.
# Override with PROM_RETENTION at deploy time if needed.
ENV PROM_RETENTION=365d

EXPOSE 9090

ENTRYPOINT ["/bin/sh", "-c", "exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=${PROM_RETENTION} \
  --web.enable-lifecycle \
  --web.enable-admin-api \
  --web.console.libraries=/usr/share/prometheus/console_libraries \
  --web.console.templates=/usr/share/prometheus/consoles"]
