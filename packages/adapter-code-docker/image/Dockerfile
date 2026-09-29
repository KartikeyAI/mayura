FROM node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5

ARG MAYURA_PROVENANCE
LABEL org.opencontainers.image.title="Mayura Code Sandbox" \
      org.opencontainers.image.version="1.0.0-rc.2" \
      org.opencontainers.image.base.name="node:24.14.1-alpine@sha256:8510330d3eb72c804231a834b1a8ebb55cb3796c3e4431297a24d246b8add4d5" \
      dev.mayura.code-sandbox.provenance="${MAYURA_PROVENANCE}"

WORKDIR /sandbox
COPY --chown=65532:65532 root/ /sandbox/
USER 65532:65532
# The Node.js permission model inside the container too: the worker may read only /sandbox, and cannot write files,
# start processes or threads, load native addons or compile JavaScript from strings.
ENTRYPOINT ["node", "--permission", "--allow-fs-read=/sandbox", "--disallow-code-generation-from-strings", "/sandbox/worker.mjs"]
