#!/bin/sh
# Substitute __SLACK_WEBHOOK_URL__ in the config from $SLACK_WEBHOOK_URL,
# then exec alertmanager. Writes to /tmp so the source (which may be a
# read-only mounted volume in docker-compose) is never modified.
set -e

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "WARN: SLACK_WEBHOOK_URL not set — slack-webhook receiver will get a placeholder URL and silently fail to deliver." >&2
  SLACK_WEBHOOK_URL="https://example.invalid/no-webhook-set"
fi

sed "s|__SLACK_WEBHOOK_URL__|${SLACK_WEBHOOK_URL}|g" \
  /etc/alertmanager/alertmanager.yml > /tmp/alertmanager.yml

exec /bin/alertmanager \
  --config.file=/tmp/alertmanager.yml \
  --storage.path=/alertmanager \
  --log.level=debug
