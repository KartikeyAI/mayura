# Support policy

Mayura `0.x` releases and `1.0.0` release candidates (`1.0.0-rc.N`) are pre-releases. They receive best-effort community support only, carry no response-time or maintenance SLA, and may contain incompatible changes documented in the changelog. No pre-release is approved for production or hostile-code execution merely because its tests pass.

Only the environments in [Supported platforms](docs/project/support.md) are qualified. Other environments may work but are unsupported until added with retained evidence. Security reports follow [SECURITY.md](SECURITY.md); suspected vulnerabilities must not be posted in public issues.

The latest pre-release is the only supported pre-release line. Security fixes may require immediate upgrade and will not expand permissions or data destinations silently.

From 1.0, the [versioning and stability policy](docs/project/versioning.md) applies. It covers which contracts are stable, how SemVer is applied, a minimum 6-month deprecation period, and the support window for the previous major and each Node.js LTS line. The window lengths are proposed defaults that the maintainers confirm before 1.0.0 is published.
