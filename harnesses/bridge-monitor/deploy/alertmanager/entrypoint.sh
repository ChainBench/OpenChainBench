#!/bin/sh
set -e

# Alertmanager does not expand env vars in its YAML by itself. Substitute the
# SLACK_WEBHOOK_URL placeholder at container start using sed (busybox-safe — no
# envsubst dependency). The Slack webhook URL contains only /, alphanumerics and
# colons so | as the sed delimiter is safe.
if [ -z "$SLACK_WEBHOOK_URL" ]; then
  echo "⚠️  SLACK_WEBHOOK_URL not set — alerts will be dropped by Slack receiver."
fi

sed "s|\${SLACK_WEBHOOK_URL}|${SLACK_WEBHOOK_URL}|g" \
  /etc/alertmanager/alertmanager.yml.tmpl \
  > /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=info
