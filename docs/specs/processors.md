# Native processor and guardrail foundation

Status: experimental optional package design, implemented alongside deterministic conformance tests. This is a subset of the full guardrail plan, not completion of G01–G11 or a claim of general prompt-injection prevention.

## Public developer journey

`@mayura/guardrails` depends only on the core contracts. A pipeline has ordered content processors followed by a parallel required-guard barrier. It accepts ordinary JSON and returns a core `Outcome`; only success discloses processed content. An application can use the same pipeline at input or output boundaries.

```ts
const pipeline = createPipeline({
  processors: [normalizeUserMessage(), redactPII({ email: true, phone: false })],
  guards: [protectLiterals({ literals: ["a protected application-owned marker"] })],
  timeoutMs: 5_000,
});

const result = await pipeline.process(untrustedInput, {
  runId, callId, scope, signal, boundary: "input",
});
if (result.status === "succeeded") {
  // Use this exact admitted value, never the original untrusted input.
  consume(result.output.value);
}
```

Callbacks and processors are trusted application code. Cooperative deadlines bound awaited work and stop new dispatch; this package cannot hard-kill synchronous JavaScript, constrain imports, or prevent a callback from making its own external calls. The deterministic helpers below make no network calls or model charges. Separate, explicitly configured auxiliary helpers now provide metered model evaluation, moderation and language processing; those helpers remain explicitly caller-wired. Separate [runtime-managed moderation](runtime-managed-guardrails.md) now binds definition-only checks to actual ephemeral runs. General injection classifiers are not implemented. See [auxiliary guardrails](auxiliary-guardrails.md).

## Content identity and authorization barrier

1. Copy input through the bounded plain-JSON contract without invoking getters or `toJSON`.
2. Deep-freeze a snapshot with a positive version and a domain-separated SHA-256 digest of canonical JSON. Object-key order does not change the digest; content changes do. Digests are content fingerprints, not authentication signatures or secrets.
3. Run processors in declared order. Each receives the immutable snapshot and a bounded context; each successful transform creates a new version even if it preserves the same value.
4. Run all required guards in parallel against the final immutable value. Record allow evidence against that exact version and digest. No guard result for an earlier transform is reused.
5. Release only after every required guard allows. Exceptions, malformed verdicts, cancellation, or deadlines never release content. Raw guard reasons and exception messages are withheld.

The pipeline freezes its processor/guard registry at construction and captures callable references without modifying application-owned objects. Guard IDs must be unique. Processor, guard, and context metadata are bounded. The package never exposes a mutation method on an admitted snapshot. A developer who needs another transform creates another pipeline invocation; previously issued guard evidence cannot authorize the new content automatically.

## Concrete native helpers and limitations

| Helper | Behavior | Deliberate limits |
| --- | --- | --- |
| `normalizeUserMessage()` | A string, or the `content` field of a JSON envelope, becomes `{role:"user",content:...}`. Supplied system/developer/tool roles, tool-call fields, and other envelope metadata are discarded. | Does not classify instructions inside user content. Does not reconstruct multimodal provider envelopes or trust client-supplied authority. |
| `redactPII({email,phone})` | Recursively replaces matching string-value spans with configurable fixed labels. Email matching defaults on; phone matching defaults off because ambiguity is high. | Heuristic recognizers, not complete PII detection or a compliance certification. Keys are preserved. Unicode/local email forms and unusual telephone formats may be missed; code-like emails and 10–15-digit identifiers may be false positives. Phone-like dates with fewer than ten digits are left unchanged. No arbitrary user regex execution. |
| `protectLiterals({literals,caseSensitive})` | Blocks when a configured literal occurs in any string leaf or key; optional case-insensitive comparison. | Exact substring detection only. No semantic injection classifier, Unicode normalization, encoded-payload detection, fuzzy matching, or complete system-prompt extraction prevention. Generic short literals may block legitimate text. |

Redaction labels and protected literals are supplied by the application, never read from ambient prompts or credentials. Their contents do not appear in error messages, block callbacks, or guard evidence. Redaction changes values before checks; guards inspect the actual redacted candidate, not a stale original.

## Explicit auxiliary model helpers

`createAuxiliaryCheck` validates an original/admitted input and complete output against supplied schemas, using an explicitly configured model, exact model grant and genuine caller-supplied `Budget`. It retains original/admitted content and digest-bound evidence on success. Known usage settles even when the model envelope is malformed or completes after cancellation; unknown usage remains reserved. It does not create credit, retry, invoke tools, follow continuation state or discover credentials.

`detectAndTranslate` is a content processor for application-classified `prose`/`protected` segments. It meters detection and translation separately, keeps protected segments out of both requests, preserves originals and exact segment mappings, and reports low-confidence preservation without inventing a translation. Applications must classify exact code, identifiers, paths and secrets before this boundary; plain text is not automatically safe prose.

`createModerationGuard` is a required guard backed by a typed auxiliary decision. Unavailable or malformed evaluation never becomes approval. Parallel moderation checks must share the owning account; invoking its explicit `evaluate` and `check` methods separately performs and charges separate calls. Moderation and translation remain fallible model outputs, not validated meaning or comprehensive prompt-injection prevention.

Local destination-aware egress guards run before auxiliary dispatch. Post-disclosure moderation cannot undo an earlier request. The application still owns runtime account/identity/permission/operation-limit wiring and content retention; these helpers are not an automatic runtime middleware layer. The [auxiliary contract](auxiliary-guardrails.md) defines limits, evidence and late-settlement behavior.

## Block handling

An optional `onBlocked` callback receives only safe boundary/run/call metadata, candidate version/digest, and a stable error code. It receives neither content, protected literals, reasons, nor raw exceptions. Callback failures remain fail-closed and are sanitized. Callback execution shares the pipeline's remaining deadline; a deadline or cancellation may prevent notification. This is a bounded notification facility, not a durable violation-delivery guarantee.

## Bounded batch output

`releaseBatches(source, pipeline, context, options)` consumes a trusted asynchronous source of text chunks. It concatenates complete bounded batches and passes each batch through the same pipeline before yielding an admitted snapshot. It never yields the raw source chunks. Limits bound chunk count per batch, UTF-8 batch size, batch count, and total stream duration; oversized chunks fail without releasing them. Cancellation requests source cleanup and does not imply the source's external work was undone.

Each batch is independently admitted. A later block cannot retract earlier released batches. A protected span split across batches can evade a batch-local recognizer. Applications requiring whole-response safety must buffer and guard the whole response instead. The batch helper itself supplies no semantic moderation or provider-token/currency enforcement; any explicitly attached auxiliary guard uses its separately supplied account and remains subject to these cross-batch disclosure limits.

`releaseBufferedOutput(source, pipeline, context, options)` is the fail-closed whole-response alternative. It retains all source text within explicit chunk, UTF-8 byte and duration limits, releases nothing while reading, and runs one pipeline decision over the complete concatenated transcript. Split protected literals and heuristic PII therefore reach the configured guard/processor as one candidate. Source failure, overflow, cancellation, timeout, pipeline denial and malformed data expose no partial transcript. Successful processing returns one admitted immutable snapshot, so this mode intentionally sacrifices incremental display latency for cross-chunk disclosure safety. It is not durable storage, provider cancellation or a semantic-safety guarantee beyond the configured pipeline.

## Verification gates

Tests cover deep immutability, canonical fingerprints, version progression, registry snapshots, complete parallel guard barriers, malformed/accessor verdicts, sanitized block callbacks, hanging processors/guards/callbacks, external cancellation, normalized-role stripping, recognizer matches and known false positives/negatives, transformed-candidate checks, bounded batch release, and whole-output split-secret/PII, overflow, failure and timeout behavior without partial disclosure. Auxiliary fake-model tests add genuine-account admission, exact/unknown/late usage, local egress denial, protected-span preservation, segment mappings and moderation failures. These cases are included in the integrated local checkpoint; safe tool previews/citations/events, broader browser/runtime use and live semantic-quality qualification remain separate release work.
