# Docker image promotion attestations

Status: implemented promotion verification and fail-closed Docker Scout signing pipeline; live scanner qualification is pending authenticated scanner access.

The strict Docker Code Mode profile may accept only an immutable image that has a fresh, signed promotion statement. The statement binds the exact local image content ID and embedded SPDX digest to a named builder and a vulnerability scan with zero critical, high, or unknown findings.

## Statement and signature

- `format` is exactly `mayura-docker-promotion-v1`.
- `subject` contains the exact lowercase SHA-256 image and provenance digests.
- `builderId` and scanner ID/version are bounded stable identities.
- The scan records a SHA-256 digest of the exact retained SARIF report, canonical completion timestamp, and critical/high/unknown counts. All three counts must be zero.
- Canonical issued/expiry timestamps bound the statement. Scan completion cannot follow issuance; issuance cannot follow expiry.
- The complete validated statement is serialized in one fixed field order and signed with Ed25519. Other key/signature algorithms are rejected.

The promoted adapter verifies the signature, subject, validity window, and configured maximum scan age at construction and again whenever availability is checked. It then performs the existing local Docker inspection for exact image ID and provenance label. No mutable tag, registry lookup, image pull, transparency-log claim, or caller-supplied scan exception is accepted.

## Issuance pipeline

`issueDockerImagePromotion` accepts exact UTF-8 SARIF 2.1.0 plus an Ed25519 PKCS#8 private key. It rejects malformed/oversized reports, missing result arrays, any filtered finding, non-Ed25519 keys, ambiguous timestamps, extensions at the signed-statement boundary and invalid identities. The private key is never returned.

After `pnpm build`, `pnpm code-sandbox:promote` performs a fixed pipeline: inspect the exact local image and provenance label, read Docker Scout's version, scan only the local content ID with `critical,high,unspecified`, require its exit success and a retained empty SARIF result, sign the report-bound statement, self-verify it, and retain the SARIF, proof and sanitized report under `.artifacts/code-sandbox-promotion-*`. The key path is supplied through `MAYURA_PROMOTION_PRIVATE_KEY`; key material is read but never copied into the artifact directory or console report. Authenticated Docker Scout can transmit image/package metadata to Docker's service, so supplying `MAYURA_DOCKER_CONFIG` requires separate destination/data-egress authorization.

## Boundary

The package supplies a signer primitive and fixed local pipeline, but not the Docker Scout service/database, a key authority/HSM, registry, transparency log, revocation service or license policy. Applications must protect the signing key, pin the public key through trusted configuration, qualify their scanner and host, retain evidence, and handle revocation. Local tests use generated disposable Ed25519 keys. The installed Docker Scout 1.20.4 required login and emitted no SARIF during the 2026-09-24 qualification attempt, so no real promotion was issued and the production supply-chain claim remains open.
