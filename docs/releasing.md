# Release procedure

The project owner is the release owner until another maintainer is appointed under `GOVERNANCE.md`. Releases are built from a reviewed, clean commit in controlled CI with read-only source access and no application/provider credentials.

1. Confirm the target is a development preview or has an approved stable support policy. Update `CHANGELOG.md`, migration notes, API classification and the support matrix.
2. Run the complete type, unit, integration, packed-consumer and release-gate suites on the declared matrix. Retain reports; a skipped required profile fails the release.
3. Review `pnpm-lock.yaml`, production dependency audit results, license inventory, secret scan and any native/container scan. Resolve or explicitly reject every finding before proceeding.
4. Run `pnpm release:artifacts`. It stages each public package without changing source manifests, replaces workspace ranges with the exact release version, adds the exact Apache-2.0 `LICENSE` and `NOTICE`, disables lifecycle execution, verifies archive paths/content/metadata and emits SHA-256 checksums bound to the source commit.
5. Independently review `release-manifest.json` and a sample archive. Verify the source commit, package count, names, versions, legal files, exports and absence of tests, environment files, private keys, executables and workspace ranges.
6. Publish only from protected CI using short-lived registry identity, public access and registry provenance. Source packages remain `private: true` so an ordinary workspace command cannot publish them. Registry scope ownership and repository hosting must be verified before the first external publication.
7. Verify registry provenance, checksums and clean installation from the registry, then create the signed source tag and release notes. A failed verification stops promotion; do not overwrite a published version.

The artifact manifest is provenance evidence, not a security certification. Signing credentials, registry ownership and hosted transparency/provenance are deployment controls and are never embedded in this repository.
