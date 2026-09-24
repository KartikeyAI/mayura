# Supported installation matrix

Mayura's initial development-preview consumer matrix is intentionally narrow:

| Operating system | Architecture | Runtime | Consumer package manager | Evidence |
| --- | --- | --- | --- | --- |
| Windows 11 23H2 (build 22631) | x64 | Node.js 24.14.1 | npm 11.11.0 | Clean offline packed install and first-agent execution |
| Alpine Linux 3.23 | x64 | Node.js 24.14.1 | npm 11.11.0 | Network-isolated, read-only-root container; clean offline packed install and first-agent execution |

The maintainer workspace uses pnpm 10.17.1; consumers do not need pnpm. macOS, Arm, other Node/npm versions, Bun, Deno, Yarn, pnpm consumer installs, CommonJS and edge runtimes are not currently supported claims. CI may exercise extra environments as portability signals without adding them to this matrix.

Both qualified runs install only the five base Mayura archives plus the consumer-selected Zod validator. Lifecycle scripts are disabled, the complete installed graph has no native, server, browser or sandbox package, and the credential-free agent executes once. `scripts/platform-install-check.mjs` emits a retained JSON report. The broader packed-consumer suites independently verify archive allowlists, browser separation, source/declaration maps, strict types and optional dependency profiles.

Adding a matrix entry requires the exact OS release, architecture, runtime and package-manager version; a clean packed install; the base execution check; relevant native/browser profiles; and retained CI or controlled-host evidence. Removing an entry requires a changelog entry and normal compatibility review.
