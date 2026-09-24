# @mayura/artifacts

Experimental bounded local artifact storage for Node.js. Content is staged, verified and promoted into a scope-partitioned SHA-256 store. Reads and disclosures revalidate the complete public reference and stored bytes. Bounded audits report missing, expired or corrupt objects without returning content; opaque two-phase reconciliation plans recheck candidates before deleting unretained committed objects.

Disclosure is always a download, requires an explicit classification policy and rejects active markup by default. The package does not authenticate users, persist application metadata, scan content, encrypt storage, manage backups or provide shared object storage.

See the [local artifact boundary](../../docs/specs/local-artifacts.md).
