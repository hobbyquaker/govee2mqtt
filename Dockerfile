FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js config.js example-map.json ./
COPY lib/ ./lib/

ENV NODE_ENV=production \
    GOVEE2MQTT_MQTT_URL=mqtt://localhost \
    GOVEE2MQTT_NAME=govee \
    GOVEE2MQTT_VERBOSITY=info \
    GOVEE2MQTT_STATE_DIR=/data

# the LAN API needs multicast and UDP port 4002 on the host: run with --network host;
# the scene cache lives in /data (mount a volume)
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node

ENTRYPOINT ["node", "index.js"]
