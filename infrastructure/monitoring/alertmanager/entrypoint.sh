#!/bin/sh
set -e

# Alertmanager does not expand env vars in its YAML by itself. Substitute the
# ALERT_WEBHOOK_URL placeholder at container start using sed (busybox-safe —
# no envsubst dependency). The webhook URL contains only /, alphanumerics and
# colons so | as the sed delimiter is safe.
#
# ALERT_WEBHOOK_URL: set on the Railway alertmanager service. Points at the
# internal Slack relay that forwards alert payloads to the ops channel.
if [ -z "$ALERT_WEBHOOK_URL" ]; then
  echo "WARNING: ALERT_WEBHOOK_URL not set — alerts will be dropped by the webhook receiver."
fi

if [ -z "$SLACK_WEBHOOK_URL" ]; then
  echo "WARNING: SLACK_WEBHOOK_URL not set — default receiver will drop alerts."
fi

sed -e "s|\${ALERT_WEBHOOK_URL}|${ALERT_WEBHOOK_URL}|g" \
    -e "s|\${SLACK_WEBHOOK_URL}|${SLACK_WEBHOOK_URL}|g" \
  /etc/alertmanager/alertmanager.yml.tmpl \
  > /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=debug
