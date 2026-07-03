FROM grafana/grafana:latest

USER root

# Cache buster - update this to force rebuild: v7
ARG CACHE_BUST=7

# Copy provisioning configs and dashboards source (we're in grafana folder)
COPY provisioning /etc/grafana/provisioning
COPY dashboards /dashboards-source

# Copy entrypoint script
COPY grafana-entrypoint.sh /grafana-entrypoint.sh
RUN chmod +x /grafana-entrypoint.sh

# Set permissions
RUN chown -R grafana:root /etc/grafana/provisioning /dashboards-source

USER grafana

# Environment variables.
# Admin credentials are NOT baked into the image: set GF_SECURITY_ADMIN_USER
# and GF_SECURITY_ADMIN_PASSWORD on the Railway service (Grafana reads GF_*
# env vars natively). Without them Grafana falls back to its stock
# admin/admin bootstrap and forces a password change on first login.
ENV GF_AUTH_ANONYMOUS_ENABLED=true
ENV GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
ENV GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/head_lag.json

# Prometheus datasource URL (overridden by staging deployment)
ENV PROMETHEUS_URL=http://prometheus.railway.internal:9090

EXPOSE 3000

# Use custom entrypoint
ENTRYPOINT ["/bin/sh", "/grafana-entrypoint.sh"]
