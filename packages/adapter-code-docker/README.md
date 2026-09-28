# mayura/adapter-code-docker

The Docker sandbox for `mayura/code-mode`, qualified `production`: the QuickJS worker inside a new container per execution. It requires exact local `sha256:` image and SPDX-provenance digests and runs with no network, a read-only root, non-root UID/GID, no Linux capabilities, no-new-privileges, Docker's default seccomp profile, bounded process, memory, CPU and open-file limits, a bounded `noexec` `tmpfs` and no log driver. The container is force-removed however the execution ends.

```ts
import { createDockerQuickJsSandboxAdapter } from 'mayura/adapter-code-docker';

const adapter = createDockerQuickJsSandboxAdapter({
  dockerPath: '/usr/bin/docker',
  image: 'sha256:<exact-local-image-id>',
  provenance: 'sha256:<exact-SPDX-document-digest>',
  runtime: 'runsc', // optional: gVisor
});
```

`host` selects a local daemon socket, for example a rootless daemon. For a promoted environment, use `createPromotedDockerQuickJsSandboxAdapter` with an application-pinned Ed25519 public key and signed `mayura-docker-promotion-v1` statement. Generate the exact signing bytes with `serializeDockerImagePromotion`, or issue a proof from retained empty SARIF with `issueDockerImagePromotion`. The statement binds the image and provenance digests and the exact scan-report digest, and requires zero critical, high or unknown findings. The adapter re-verifies the promotion before every execution.

The CLI path must be absolute and trusted. Mutable image names, PATH lookup, image pulls, host mounts and Docker-socket forwarding are unsupported. Build the image from the shipped `image/Dockerfile` and rebuild it when you upgrade Mayura (in this repository: `pnpm code-sandbox:image`). The package verifies signed promotions but does not bundle a scanner, signer, key authority, transparency log or revocation service. Containers share the host kernel; for hostile multi-tenant code use gVisor. See the [Code Mode guide](../../docs/guides/code-mode.md) and the [sandbox guarantees](../../docs/project/security.md#code-mode-sandboxing).
