# Docker image promotion attestations

Status: implemented promotion-verification foundation; no production scanner or signing service is bundled.

The strict Docker Code Mode profile may accept only an immutable image that has a fresh, signed promotion statement. The statement binds the exact local image content ID and embedded SPDX digest to a named builder and a vulnerability scan with zero critical, high, or unknown findings.

## Statement and signature

- `format` is exactly `mayura-docker-promotion-v1`.
- `subject` contains the exact lowercase SHA-256 image and provenance digests.
- `builderId` and scanner ID/version are bounded stable identities.
- The scan records a SHA-256 vulnerability-database digest, canonical completion timestamp, and critical/high/unknown counts. All three counts must be zero.
- Canonical issued/expiry timestamps bound the statement. Scan completion cannot follow issuance; issuance cannot follow expiry.
- The complete validated statement is serialized in one fixed field order and signed with Ed25519. Other key/signature algorithms are rejected.

The promoted adapter verifies the signature, subject, validity window, and configured maximum scan age at construction and again whenever availability is checked. It then performs the existing local Docker inspection for exact image ID and provenance label. No mutable tag, registry lookup, image pull, transparency-log claim, or caller-supplied scan exception is accepted.

## Boundary

The package provides verification and a strict factory, not a key authority, scanner, signer, registry, revocation service, or promotion pipeline. Applications must protect the signing key, pin the public key through trusted configuration, produce statements only after their qualified scan/licence policy passes, retain evidence, and handle revocation. Local tests use generated disposable Ed25519 keys and do not qualify a production supply chain.
