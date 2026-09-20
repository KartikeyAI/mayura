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

Callbacks and processors are trusted application code. Cooperative deadlines bound awaited work and stop new dispatch; this package cannot hard-kill synchronous JavaScript, constrain imports, or prevent a callback from making its own external calls. Native helpers do not make network calls or incur model charges. Model-assisted moderation, language detection/translation, injection classifiers, and their budgeted broker integrations are not implemented here.

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

## Block handling

An optional `onBlocked` callback receives only safe boundary/run/call metadata, candidate version/digest, and a stable error code. It receives neither content, protected literals, reasons, nor raw exceptions. Callback failures remain fail-closed and are sanitized. Callback execution shares the pipeline's remaining deadline; a deadline or cancellation may prevent notification. This is a bounded notification facility, not a durable violation-delivery guarantee.

## Bounded batch output

`releaseBatches(source, pipeline, context, options)` consumes a trusted asynchronous source of text chunks. It concatenates complete bounded batches and passes each batch through the same pipeline before yielding an admitted snapshot. It never yields the raw source chunks. Limits bound chunk count per batch, UTF-8 batch size, batch count, and total stream duration; oversized chunks fail without releasing them. Cancellation requests source cleanup and does not imply the source's external work was undone.

Each batch is independently admitted. A later block cannot retract earlier released batches. A protected span split across batches can evade a batch-local recognizer. Applications requiring whole-response safety must buffer and guard the whole response instead. There is no claim of semantic moderation, global transcript safety, or provider-token/currency enforcement in this batch helper.

## Verification gates

Tests cover deep immutability, canonical fingerprints, version progression, registry snapshots, complete parallel guard barriers, malformed/accessor verdicts, sanitized block callbacks, hanging processors/guards/callbacks, external cancellation, normalized-role stripping, recognizer matches and known false positives/negatives, transformed-candidate checks, and bounded release that does not expose a rejected raw batch. Packed/browser/runtime matrix qualification remains a separate stable-release gate.
