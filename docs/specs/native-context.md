# Native context assembly

Status: experimental independent `@mayura/context` foundation. Implements bounded, provenance-preserving selection from caller-supplied candidates. It does not implement semantic retrieval, model summarization, generated compaction, OpenViking, speculative work, or provider prompt caches.

## Public API

`assembleContext({scope, policyVersion, candidates, sources, budget, allowedSensitivities, estimator?, asOf?})` returns a deeply immutable assembly containing selected items, explicit exclusion evidence, byte/token-estimate usage, an exact canonical JSON payload, and a SHA-256 fingerprint. The package depends only on core contracts and uses global WebCrypto; it requires no database, model, memory provider, network, or paid service.

Each candidate includes an application-owned ID, exact principal/project scope, current source ID/revision/kind, provenance reference/observation time/origin/confidence, trust, sensitivity, category, priority, optional explicit pin, and JSON content. The caller supplies authoritative source states for this assembly: each source is active at an exact revision or deleted. Observed source content is never automatically upgraded to trusted instructions. Selection preserves trust and provenance without creating model system/developer messages.

Candidates may additionally carry `validity: {from, until}` with canonical UTC ISO strings and `until: null` for an open-ended interval. Admission is inclusive at `from` and exclusive at `until`. `asOf` is an optional canonical UTC ISO timestamp; when omitted, assembly snapshots the current time once before any asynchronous work. The chosen time is returned, serialized, and fingerprinted. Invalid intervals or timestamps fail validation. Optional future/expired items are excluded as `not_yet_valid`/`expired`; required items fail closed. Omitting validity preserves the existing timeless-evidence behavior. Explicit `asOf` supports reproducible historical assemblies, but is a trusted caller assertion, not proof of wall-clock freshness.

Optional `provenance.upstream: {sourceId, revision, sha256}` preserves the identity of the original observed source separately from the canonical context source identity. The SHA-256 is exactly 64 lowercase hexadecimal characters; the assembler validates its shape and preserves it, but does not fetch, authenticate, or independently hash an external source. This metadata is copied and included in the admitted payload/fingerprint.

```ts
const assembly = await assembleContext({
  scope,
  policyVersion: "context-policy-1",
  candidates,
  sources: currentSourceStates,
  allowedSensitivities: ["public", "internal"],
  budget: { maxBytes: 64_000, maxEstimatedTokens: 64_000, reservedBytes: 4_000, reservedTokens: 4_000 },
});
// Use the selected items or the exact measured payload, preserving their lower-trust origin.
useContext(assembly.serialized);
```

Application-owned metadata determines authority and continuity. An untrusted document or model response must not be allowed to mint its own trusted/pinned metadata merely by placing such fields in content. Scope equality is a mandatory isolation boundary, not a substitute for source ACL enforcement: callers must obtain candidates/current source states through their authorized source adapters. Re-read live sources before edits or assertions requiring current state. The assembler cannot detect a caller presenting an already stale source-state manifest as current.

## Continuity rules

An item is required if explicitly pinned or categorized as `hard_constraint`, `pending_approval`, `unresolved_blocker`, or `outstanding_task`. The application must deliberately recategorize resolved work; selection never infers resolution or converts pending work to completion.

All current-scope required items must survive assembly. If a required item is stale, deleted, lacks a current source, is not valid at the chosen `asOf`, is denied by the supplied sensitivity policy, or cannot fit the remaining byte/token-estimate budgets, assembly fails explicitly with no partial successful result. It never silently drops a required constraint to fit a budget. Pins from another principal/project do not constrain the current scope and their metadata/content are not returned.

Required items are admitted first. Eligible optional items are considered by descending priority, descending canonical observation timestamp, and ascending stable candidate ID. Equal inputs with the same `asOf` produce equal selections independent of candidate input order. Optional items that do not fit are excluded with a specific reason; smaller later items may still fit. Duplicate current-scope candidate IDs and duplicate current-scope source states are configuration errors, not arbitrary winner selection.

## Bounds and token estimation

The byte bound measures the exact UTF-8 canonical JSON payload, including scope, policy, source/provenance metadata, and selected content. Reserved bytes and reserved token estimates are deducted before selection for application-owned prompt framing, tools, and output space. Even the empty payload must fit. Preprocessing accepts at most 512 candidates within 4 MiB total candidate JSON, 1,024 source states within 1 MiB, and 256 KiB of content per candidate. Core JSON depth/node restrictions also apply. Split larger source collections into authorized candidate retrieval before assembly; this package does not silently truncate them.

The default estimator counts one estimated token per UTF-8 byte of the measured payload. This is deliberately simple and often conservative, but it is not a model tokenizer or a universal provider-token upper-bound guarantee. An optional trusted synchronous estimator supplies its own stable ID and non-negative safe-integer count for the exact payload. Provider framing, multimodal encoding, tool definitions, and future model revisions can change actual token counts; callers must reserve that space and perform the provider's final admission check. No currency guarantee is implied. Estimators are trusted local code, not model calls or hard-CPU-isolated callbacks.

## Evidence, freshness, and memory interoperability

Selected content is copied, deep-frozen, and fingerprinted using canonical JSON with domain-separated SHA-256. The assembly fingerprint covers scope, policy, the chosen `asOf`, selected source revisions, selected metadata/content (including supplied validity/upstream provenance), sensitivity policy, estimator identity, and budget configuration. It identifies the admitted payload and configuration, not the separate excluded-item report. Hashes establish deterministic identity, not source authenticity or secret protection.

Exclusion evidence never contains content. Wrong-scope and sensitivity-denied entries report only input position and reason, without candidate/source identity. Authorized stale/deleted/missing-source and budget exclusions may name the supplied candidate and source revision. No excluded candidate is silently promoted to selected context.

For native memory integration, use the memory record ID/version as the candidate's authoritative source ID/revision and current source state. Preserve its original reference, observation time, origin, confidence, and author in provenance; carry the original `sourceId`, `revision`, and `sha256` under `provenance.upstream`. Carry the record's validity interval unchanged. Direct memory `get`/`list` are inspection surfaces and may return future/expired records; lexical search filters validity at search time, but its results still need the interval carried forward for the later assembly time. A trusted application is responsible for this mapping: omitted metadata cannot be reconstructed or checked by this independent package. A record's `observed` origin is not an instruction trust grant. Source revisions are opaque strings; canonical UTC ISO timestamps match native-memory timestamps.

There is no cache in this foundation. Every call rechecks the supplied scope, sensitivity policy, source statuses, and revisions. Consequently there is no hidden cache requiring deletion invalidation. A later bounded cache must prove cross-scope isolation and source/deletion/policy invalidation independently before introduction. Durable continuity across crashes requires the application to persist the exact serialized assembly checkpoint and authoritative source state. The V14 fixture performs five JSON serialization/resume rounds and proves every designated hard constraint, unresolved blocker, pending approval and outstanding task survives; this does not claim that the stateless package owns storage.

## Verification

Conformance and property tests cover automatic required-item continuity, explicit overflow failure, repeated serialized checkpoint/resume without loss of any of the four continuity categories, deterministic ranking/permutation invariance, priority-versus-fit behavior, scope isolation, sensitive exclusion metadata, source revision changes/deletions, upstream provenance preservation, half-open validity intervals, explicit/default time snapshots, canonical fingerprints, immutable snapshots, invalid estimator handling, and reserved capacity. No generated summary or fake semantic retrieval is used to satisfy these tests.
