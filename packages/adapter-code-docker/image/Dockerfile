FROM node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5

WORKDIR /sandbox
COPY --chown=65532:65532 root/ /sandbox/
USER 65532:65532
ENTRYPOINT ["node", "/sandbox/worker.mjs"]
