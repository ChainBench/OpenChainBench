FROM prom/alertmanager:latest

USER root

# The webhook receiver URL is injected at container start from the
# ALERT_WEBHOOK_URL env var (set on the Railway service) — never baked into
# the image. entrypoint.sh substitutes the placeholder with plain sed
# (busybox-safe, no envsubst dependency).
COPY alertmanager.yml.tmpl /etc/alertmanager/alertmanager.yml.tmpl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose AlertManager port
EXPOSE 9093

ENTRYPOINT ["/entrypoint.sh"]
