FROM prom/alertmanager:latest

# Config carries __SLACK_WEBHOOK_URL__; entrypoint.sh sed-substitutes
# it from $SLACK_WEBHOOK_URL at container start. Keeps the real webhook
# URL out of the repo and out of the image layer.
COPY alertmanager.yml /etc/alertmanager/alertmanager.yml
COPY entrypoint.sh /entrypoint.sh

USER root
RUN chmod +x /entrypoint.sh
USER nobody

EXPOSE 9093

ENTRYPOINT ["/entrypoint.sh"]
