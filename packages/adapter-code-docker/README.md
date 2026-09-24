# @mayura/adapter-code-docker

Experimental outer-container adapter for the Mayura QuickJS Code Mode worker. It requires exact local `sha256:` image and SPDX-provenance digests created from the shipped Dockerfile and runs with no network, read-only root, non-root UID/GID, no Linux capabilities, no-new-privileges, default seccomp, bounded PID/memory/CPU/open-file limits and a bounded `tmpfs`.

```ts
import { createDockerQuickJsSandboxAdapter } from '@mayura/adapter-code-docker';

const adapter = createDockerQuickJsSandboxAdapter({
  dockerPath: '/usr/bin/docker',
  image: 'sha256:<exact-local-image-id>',
  provenance: 'sha256:<exact-SPDX-document-digest>',
});
```

For a promoted environment, use `createPromotedDockerQuickJsSandboxAdapter` with an application-pinned Ed25519 public key and signed `mayura-docker-promotion-v1` statement. Generate the exact signing bytes with `serializeDockerImagePromotion`, or issue a proof from retained empty SARIF with `issueDockerImagePromotion`. The statement binds image/provenance digests and the exact scan-report digest and requires zero critical, high or unknown findings. The strict adapter revalidates promotion before every availability check.

The CLI path must be absolute and trusted. Mutable image names, PATH lookup, image pulls, host mounts and Docker-socket forwarding are intentionally unsupported. Build the repository image with `pnpm code-sandbox:image`; retain its SPDX document and use the emitted image and provenance digests rather than its convenience tag.

The current profile is still marked `test`. The package verifies signed clean-scan promotion statements but does not bundle a scanner, signer, key authority, transparency log or revocation service. Local Docker Desktop evidence is not Linux multi-host, daemon, kernel or container-escape qualification. The Docker daemon and CLI are trusted host infrastructure; generated code never controls CLI arguments or image selection.
