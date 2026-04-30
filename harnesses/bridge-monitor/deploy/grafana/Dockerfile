FROM grafana/grafana:latest

USER root

# Copy provisioning configs (we're in grafana folder)
COPY provisioning /etc/grafana/provisioning

# Set permissions
RUN chown -R grafana:root /etc/grafana/provisioning

USER grafana

# Environment variables
ENV GF_AUTH_ANONYMOUS_ENABLED=true
ENV GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
ENV GF_SECURITY_ADMIN_USER=admin
ENV GF_SECURITY_ADMIN_PASSWORD=admin

EXPOSE 3000
