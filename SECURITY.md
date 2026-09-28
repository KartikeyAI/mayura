# Security policy and reporting

Mayura is in pre-release (release candidates of 1.0) and not yet approved for production or hostile-code execution. No version currently carries a supported production/security-maintenance commitment. [Security model](docs/project/security.md) describes what Mayura does and does not protect against.

In-process tools, schemas, guards and model adapters are trusted application code. Permission declarations do not prevent a malicious callback from importing host APIs. Cancellation is cooperative. The SDK does not currently include a qualified hostile-code sandbox.

Do not publish vulnerabilities, live credentials or sensitive logs in public issues. Use the source repository's private vulnerability-reporting facility (GitHub: **Security → Report a vulnerability** on [KartikeyAI/mayura](https://github.com/KartikeyAI/mayura/security)). If that is not available, email dev@rokad.co with "Mayura security" in the subject. A release owner must verify that private reporting is enabled before publishing any release.

The project owner triages reports, acknowledges them when operationally possible, limits disclosure to people needed for remediation, and coordinates a fix, advisory and credit with the reporter. No response-time SLA applies to development previews. A report may be closed as not applicable only with a recorded rationale; credible unresolved reports block release. Public disclosure occurs after a fix is available or through a mutually agreed coordinated-disclosure date.

Each release requires a reviewed threat model, dependency and secret scanning, provenance/contents verification, supported-version policy, abuse/fault evaluation, sandbox qualification, migration/restore tests and access-control review appropriate to its claims. Existing automated tests are evidence for their cases, not proof against all attacks.
