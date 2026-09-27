# Server and worker image. Both run the same build; compose.yaml chooses the command.
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
# Report artifacts: mount shared storage here (compose.yaml uses a named volume shared by server and worker).
RUN mkdir -p /data/artifacts && chown 65532:65532 /data/artifacts
USER 65532:65532
ENV NODE_ENV=production MAYURA_ENV=production RESEARCH_ARTIFACTS_DIR=/data/artifacts
EXPOSE 8080 9090
ENTRYPOINT ["node", "node_modules/@mayura/cli/dist/bin.js"]
CMD ["serve", "--app", "dist/src/app.js"]
