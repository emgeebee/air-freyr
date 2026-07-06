FROM node:20-alpine

# python3: yt-dlp (via youtube-dl-exec) · bash: entrypoint · deno: YouTube JS challenges
RUN apk add --no-cache python3 bash curl unzip \
  && curl -fsSL https://deno.land/install.sh | sh \
  && mv /root/.deno/bin/deno /usr/local/bin/deno

COPY docker/serve-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

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

ENTRYPOINT ["/entrypoint.sh"]
