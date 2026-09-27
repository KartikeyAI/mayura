# mayura/artifacts

Experimental bounded local artifact storage for Node.js. Content is staged, verified and promoted into a scope-partitioned SHA-256 store. Reads and disclosures revalidate the complete public reference and stored bytes. Bounded audits report missing, expired or corrupt objects without returning content; opaque two-phase reconciliation plans recheck candidates before deleting unretained committed objects. Whole-scope portable backups bind sorted reference metadata and content to an integrity envelope; restore is scope-pinned, bounded, idempotent and refuses unrelated destination objects. Storage exhaustion is fail-closed, cleans short temporary writes where possible and preserves retryable staged authority.

Disclosure is always a download, requires an explicit classification policy and rejects active markup by default. The package does not authenticate users, persist application metadata, scan content, encrypt backups, schedule backups, manage remote retention or provide shared object storage.

See the [local artifact boundary](../../docs/specs/local-artifacts.md).
