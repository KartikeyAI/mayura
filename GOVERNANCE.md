# Mayura governance

Mayura uses maintainer-led governance. Until additional maintainers are appointed, the project owner is the release owner and final decision maker. Maintainers are listed in the protected repository settings; repository access, not an unverified document edit, grants release authority.

Maintainers review changes, triage security reports, qualify dependencies, approve compatibility decisions and produce releases. A release requires one release owner who did not author all security-sensitive changes to review the retained gate report, artifact manifest, checksums, dependency audit, license/notice inventory and changelog. The release owner may stop a release for any unresolved integrity, security, compatibility or provenance concern.

Material changes to execution authority, persistence, public contracts, security boundaries or governance require a public proposal or ADR and normal review. API stability follows [Versioning and stability](docs/project/versioning.md); supported environments follow [Supported platforms](docs/project/support.md). Contributors gain maintainer status through sustained reviewed contributions and demonstrated security/release judgment. The project owner appoints or removes maintainers and records the decision in repository history.

Development previews receive no SLA. A stable support window and deprecation period must be approved and documented before any 1.0 release. Commercial support, if offered later, is separate from open-source governance and cannot silently change framework permissions or license terms.
