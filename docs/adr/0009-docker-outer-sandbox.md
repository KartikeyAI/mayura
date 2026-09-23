# ADR 0009: Docker as the first outer Code Mode sandbox

Status: accepted for an experimental, test-qualified Linux-container profile.

## Context

The QuickJS child adapter supplies an interpreter boundary, but a compromised interpreter would still execute inside its Node process. Code Mode therefore needs a separately packaged outer boundary that denies host networking, credentials, writable host paths, excess processes and unconstrained compute. This first profile must remain optional and must not add Docker or native dependencies to the base SDK.

Docker supplies Linux namespaces, cgroups, a default seccomp profile and capability controls on the available local test host. These controls materially strengthen the QuickJS profile, but a container shares a kernel with its host or Docker Desktop VM and is not equivalent to a microVM. The Docker daemon, CLI, kernel, base image and image-build pipeline remain trusted infrastructure.

## Decision

Ship `@mayura/adapter-code-docker` as an optional outer adapter around the versioned QuickJS worker protocol. The adapter accepts only an absolute trusted Docker CLI path and an exact locally present `sha256:` image content ID. It never performs PATH lookup, pulls an image, accepts a mutable tag, mounts a host path, forwards the host environment or derives a CLI argument from generated source.

The shipped image recipe pins `node:24.14.1-alpine` by manifest digest, copies only the compiled worker and exact QuickJS 0.32.0 dependency closure, and runs as UID/GID 65532. The build helper uses `--pull=false` and `--network=none`, retains a bounded report, and returns the resulting local image ID. The runtime uses `--pull=never`, no network, a read-only root, no Linux capabilities, no-new-privileges, Docker's built-in seccomp profile, a 16-process limit, a 64-file-descriptor limit, one CPU, matching memory/swap limits, no IPC namespace sharing and a bounded `noexec,nosuid,nodev` `/tmp` filesystem.

Each execution gets a random adapter-owned container name. Normal completion, failure and caller cancellation close the protocol and force-remove that exact container. The adapter remains qualification `test`; applications must explicitly opt into test adapters.

## Evidence and consequences

On Windows x64 with Node 24.14.1, Docker Engine 29.4.2 and a Linux/amd64 daemon, the image builds from the pinned recipe and the live suite executes a brokered tool through the ordinary Code Mode boundary. Runtime inspection verifies the non-root user, network/IPC modes, read-only root, dropped capabilities, security options, PID/CPU/memory/open-file limits, sole bounded `tmpfs` mount and absence of host binds. CPU exhaustion fails closed, caller cancellation force-removes the container, and no named test container remains. An isolated offline consumer also compiles the public package without ambient Node types or a bundled Docker client.

This evidence does not establish resistance to a container or kernel escape, signed image provenance, SBOM/vulnerability policy, daemon hardening, rootless operation, Linux distribution coverage, macOS/Windows compatibility, production load, or durable no-replay semantics. It therefore advances but does not close V15. Production qualification needs a supported host matrix, independent escape testing, image signing/scanning and durable phase/approval recovery evidence. See the [Docker adapter specification](../specs/code-mode-docker.md), [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) and [Docker seccomp guidance](https://docs.docker.com/engine/security/seccomp/).

