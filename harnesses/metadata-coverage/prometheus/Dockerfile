FROM prom/prometheus:v2.49.1

USER root

# Pick which prometheus.yml to bake in (prometheus.yml for prod, prometheus.staging.yml for staging).
ARG PROMETHEUS_CONFIG=prometheus.yml

COPY ${PROMETHEUS_CONFIG} /etc/prometheus/prometheus.yml
COPY alert_rules.yml /etc/prometheus/alert_rules.yml

EXPOSE 9090

# --enable-feature=expand-external-labels: lets global.external_labels read ${ENVIRONMENT} from env
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--web.enable-lifecycle", "--web.enable-admin-api", "--enable-feature=expand-external-labels"]
