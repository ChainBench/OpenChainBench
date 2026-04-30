FROM prom/alertmanager:latest

USER root

# Newer prom/alertmanager images are busybox-based (no apk). We use plain sed in
# entrypoint.sh to substitute SLACK_WEBHOOK_URL — no envsubst dependency needed.

COPY alertmanager.yml.tmpl /etc/alertmanager/alertmanager.yml.tmpl
COPY templates.tmpl        /etc/alertmanager/templates.tmpl
COPY entrypoint.sh         /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9093

ENTRYPOINT ["/entrypoint.sh"]
