FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 atomicparsley ca-certificates bash \
  && rm -rf /var/lib/apt/lists/*

COPY docker/serve-entrypoint.sh /usr/local/bin/serve-entrypoint.sh
RUN chmod +x /usr/local/bin/serve-entrypoint.sh

ENV AIRFREYR_HOSTNAME=0.0.0.0 \
    AIRFREYR_PORT=3797 \
    AIRFREYR_QUEUE_DIR=/data/queues \
    AIRFREYR_OUTPUT_DIR=/data/music \
    AIRFREYR_CONFIG=/data/config/conf.json \
    AIRFREYR_REFRESH_HOURS=3 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /data
RUN mkdir -p /data/queues /data/music /data/config

VOLUME ["/data/queues", "/data/music", "/data/config"]

EXPOSE 3797

ENTRYPOINT ["/usr/local/bin/serve-entrypoint.sh"]
