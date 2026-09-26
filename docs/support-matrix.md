# Supported installation matrix

Mayura's initial development-preview consumer matrix is intentionally narrow:

| Operating system | Architecture | Runtime | Consumer package manager | Evidence |
| --- | --- | --- | --- | --- |
| Windows 11 23H2 (build 22631) | x64 | Node.js 24.14.1 | npm 11.11.0 | Clean offline packed install and first-agent execution |
| Alpine Linux 3.23 | x64 | Node.js 24.14.1 | npm 11.11.0 | Network-isolated, read-only-root container; clean offline packed install and first-agent execution |
| Alpine Linux 3.24 | x64 | Node.js 22.23.2 | npm 10.9.8 | Network-isolated, read-only-root container; clean offline packed install and first-agent execution; offline-built server/worker image with PostgreSQL compose smoke |

Package `engines` declare `>=22.12.0 <23 || >=24.14.1 <25`; 22.12.0 is the first 22.x release that loads ES modules from CommonJS without a flag. The complete unit suite runs on both lines in the hosted CI matrix (`.github/workflows/ci.yml`); until that CI runs, Node.js 22 evidence is the two container checks above. The maintainer workspace uses pnpm 10.17.1; consumers do not need pnpm. macOS, Arm, Node.js lines other than 22 LTS (>= 22.12.0) and 24 (>= 24.14.1), other npm versions, Bun, Deno, Yarn, pnpm consumer installs, CommonJS and edge runtimes are not currently supported claims. CI may exercise extra environments as portability signals without adding them to this matrix.

Both qualified runs install only the five base Mayura archives plus the consumer-selected Zod validator. Lifecycle scripts are disabled, the complete installed graph has no native, server, browser or sandbox package, and the credential-free agent executes once. `scripts/platform-install-check.mjs` emits a retained JSON report. The broader packed-consumer suites independently verify archive allowlists, browser separation, source/declaration maps, strict types and optional dependency profiles.

Adding a matrix entry requires the exact OS release, architecture, runtime and package-manager version; a clean packed install; the base execution check; relevant native/browser profiles; and retained CI or controlled-host evidence. Removing an entry requires a changelog entry and normal compatibility review.
