# Support policy

Mayura 1.x is a stable release line. Every public entry point follows semantic versioning: an upgrade within 1.x does
not break the documented API, stored data changes only through explicit migrations, and deprecated APIs stay for at
least one minor release and 6 months. The [versioning and stability policy](docs/project/versioning.md) has the
details.

## Which versions are supported

- The **latest 1.x release** receives features, fixes and security fixes. Fixes are not backported to earlier 1.x
  releases, so upgrade to the latest one before reporting a problem.
- The **previous major version** receives security fixes for 12 months after the next major's first release.
- **Node.js 22 and 24** are supported while each is in active or maintenance LTS. Bun, Deno, Cloudflare Workers and
  Vercel Edge are supported for every entry point that is not Node-only.
- **Release candidates** (such as `1.1.0-rc.1`) are pre-releases with best-effort support only.

Only the environments in [Supported platforms](docs/project/support.md) are tested and supported. Others may work but
are unsupported until they are added with evidence.

## Getting help

Open an issue at [github.com/KartikeyAI/mayura/issues](https://github.com/KartikeyAI/mayura/issues) for questions,
bugs and integration requests. [Reporting a bug](docs/project/support.md#reporting-a-bug) lists what to include.

Support is community support on a best-effort basis, with no response-time commitment.

## Security

Do not post vulnerabilities, credentials or sensitive logs in public issues. Follow [SECURITY.md](SECURITY.md). A
security release never widens permissions, changes where data is sent or turns on telemetry.
