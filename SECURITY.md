# Security status and reporting

Mayura is pre-release and not approved for production or hostile-code execution. No version currently carries a supported production/security-maintenance commitment.

In-process tools, schemas, guards and model adapters are trusted application code. Permission declarations do not prevent a malicious callback from importing host APIs. Cancellation is cooperative. The SDK does not currently include a qualified hostile-code sandbox.

Do not publish private vulnerabilities, live credentials or sensitive logs in public issues. For this local development checkout, report findings privately to the project owner through the existing private project channel. The owner must establish and verify a public private-reporting channel, response ownership and disclosure policy before public release; no email address or hosted advisory endpoint is invented here.

Required release work includes a threat model, dependency and secret scanning, provenance/contents verification, supported-version policy, abuse/fault evaluation, sandbox qualification, migration/restore tests and access-control review. Existing automated tests are evidence for their cases, not proof against all attacks.
