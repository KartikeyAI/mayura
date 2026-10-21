---
title: "V1.2 release validation status"
description: "Completed local qualification, experimental surfaces and the checks still required before releasing Mayura V1.2."
---

V1.2 is unreleased. This status records local qualification completed on **2026-10-21** on Windows x64, using
Node 24.14.1 for core checks and Node 24.15.0 for framework starter qualification. It does not replace the full
release CI matrix or establish compatibility with real external services.

## Completed local qualification

| Check | Result |
| --- | --- |
| Unit suite | 5,296 passed, zero failed; six conditional PostgreSQL cases skipped |
| PostgreSQL journal profiles | 12 passed, including those six conditional cases |
| Integration, latest executed result per case | 2,338 passed, zero unresolved failures |
| Final serial integration rerun | 107 passed, clearing the remaining 52 failures |
| Client/server regressions | 261 passed |
| AG-UI native server integration | Five passed |
| Build, type checks and documentation | Passed; 451 documentation snippets checked |
| Public API report | Current at 179 entry points and 2,854 symbols |
| Edge compatibility | 62 compatible entry points; 13 explicitly Node-only |
| Shared runtime checks | Node, Bun, Deno, workerd and Vercel Edge passed |
| Offline consumers and upgrade from V1.1.0 | Passed |
| Published package bundle | 75 public entry points and 105 extensions passed |
| Release archive verification | 106 packages passed |
| Starter, template and offline example checks | 11 starters, eight templates and 18 examples passed |
| Website build and link checks | Passed; 200 pages and 45,057 links in the qualification snapshot |
| Frozen installation, secret scan and licenses/SBOM | Passed; 450 SBOM components, no license findings |

These counts describe the completed qualification snapshot before this status page was added. Documentation edits
are checked again during release preparation. The archives were staged for verification, not published; the release
workflow must generate new archives bound to the final source commit and V1.2 version.

The integration result combines the latest execution of each case. The original all-service run had 54 failures
and 313 skipped cases. Focused reruns cleared all executed failures, including a final serial run of 107 cases
that cleared the remaining 52 failures. Filtered skips never overwrite an executed result. This is not a claim that
the original full run passed or that skipped external profiles were qualified. Database stress cases passed without
concurrent builds and unit-suite load. The final commit still needs a clean required CI run.

## Remaining qualifications and limitations

- **Release CI:** the full Linux, Windows and macOS matrix with Node 22/24 and required database profiles must pass
  on the final source. Local Windows reruns do not replace that gate.
- **Providers and gateways:** offline transports and the provider harness dry run passed. Paid inference, real
  embedding endpoints, gateway accounting and remote discovery behavior have not been qualified.
- **Authorization:** OpenFGA, Cedar, Permit.io and Oso passed offline tests and package checks. Real provider/native
  engine interoperability, deployed policies and revision consistency remain host responsibilities and unqualified
  here. Amazon Verified Permissions is outside the implemented Cedar adapter.
- **RAG:** the [experimental RAG surface](rag.md) passed offline tests, including fake vector transports/SQL executors
  and local SQLite native-memory checks. This does not establish real vector/reranker service compatibility, SQL
  query plans, deployment limits or read-after-write visibility on eventually consistent services.
- **AG-UI:** the [experimental bounded profile](ag-ui.md) passed adapter and native server tests. The opt-in reference
  HttpAgent/schema harness, CopilotKit compatibility and the notebook's rendered browser flow remain unqualified.
  Arbitrary in-flight paid-operation recovery, conversation branching, audio/video media and reasoning disclosure
  remain outside the profile.
- **Frameworks and UI:** framework builds, mounted HTTP approval/worker flows and offline packed server contracts
  passed. Shared Bun/Deno/workerd checks do not qualify the Hono-specific Bun/Deno or Workers/D1 application paths.
  Rendered browser interaction, visual/accessibility checks and live deployment qualification remain outstanding.
  See [framework starters](framework-starters.md) and [copy-in UI](copy-in-ui.md).

Retain the experimental labels and these limits when publishing. Any claim of stable external interoperability
requires the corresponding real-service or reference-client qualification before release; an offline pass is not
sufficient evidence for that claim.

## Release preparation

1. Review and commit the complete V1.2 implementation, validation fixes and documentation on `release-1.2`.
2. Run the required qualification workflow against the reviewed commit and resolve required failures or skips.
3. Merge through the reviewed path into `main`, the only publishing branch, and require its qualification to pass.
4. Verify npm credentials or trusted publishing for the core package and extensions, the protected release
   environment, and the publishing enablement setting.
5. Dry-run the release workflow for **1.2.0** to regenerate versioned archives, checksums, SBOM and release notes from
   the final source. Publish and tag only through the approved release workflow.

Source manifests remain at 1.1.0 until the release workflow applies the coordinated version bump. Local validation
has not pushed, tagged, published or deployed V1.2.
