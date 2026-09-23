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

The CLI path must be absolute and trusted. Mutable image names, PATH lookup, image pulls, host mounts and Docker-socket forwarding are intentionally unsupported. Build the repository image with `pnpm code-sandbox:image`; retain its SPDX document and use the emitted image and provenance digests rather than its convenience tag.

The current profile is still marked `test`. Local Docker Desktop evidence is not Linux multi-host, daemon, kernel, container-escape or signed/scanned image qualification. The Docker daemon and CLI are trusted host infrastructure; generated code never controls CLI arguments or image selection.
