FROM prom/prometheus:v2.49.1

USER root

# Pick which prometheus.yml to bake in (prometheus.yml for prod, prometheus.staging.yml for staging).
ARG PROMETHEUS_CONFIG=prometheus.yml

COPY ${PROMETHEUS_CONFIG} /etc/prometheus/prometheus.yml

EXPOSE 9090

CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--web.enable-lifecycle", "--web.enable-admin-api"]
