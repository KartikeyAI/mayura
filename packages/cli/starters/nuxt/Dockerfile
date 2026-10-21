FROM node:24.15.0-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NUXT_TELEMETRY_DISABLED=1
RUN npm run build && mkdir -p /app/.data && chown node:node /app/.data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NITRO_HOST=0.0.0.0 NITRO_PORT=3000
USER node
EXPOSE 3000
CMD ["npm", "start"]
