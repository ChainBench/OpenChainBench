FROM prom/alertmanager:latest

# Copy AlertManager configuration
COPY alertmanager.yml /etc/alertmanager/alertmanager.yml

# Expose AlertManager port
EXPOSE 9093

# Run AlertManager
CMD ["--config.file=/etc/alertmanager/alertmanager.yml", \
     "--storage.path=/alertmanager", \
     "--log.level=debug"]
