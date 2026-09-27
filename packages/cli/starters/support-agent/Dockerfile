# Server and worker image. Both run the same build; compose.yaml chooses the command. The chat UI (web/) is a static
# bundle: build it with `npx vite build web` and serve web/dist from your static host or reverse proxy.
FROM node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5
WORKDIR /app
COPY --from=build --chown=65532:65532 /app/package.json ./
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
USER 65532:65532
ENV NODE_ENV=production MAYURA_ENV=production
EXPOSE 8080 9090
ENTRYPOINT ["node", "node_modules/mayura/lib/cli/dist/bin.js"]
CMD ["serve", "--app", "dist/src/app.js"]
