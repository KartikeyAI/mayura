# Metered auxiliary model guardrails

Status: experimental independent guardrail-package slice. Implements explicit auxiliary evaluation, language processing, and moderation helpers; it does not complete G01–G11/V09–V11 or provide automatic runtime integration, general prompt-injection prevention, semantic accuracy, or compliance certification.

## Admission and public API

`createAuxiliaryCheck({id,version,model,instructions,input,output,budget,permissions,limits?,egressGuards?})` returns a frozen typed evaluator. `evaluate(value, context)` returns an `Outcome` containing immutable original input, schema-admitted input, validated output, and evidence identifying the check/model, scoped invocation, content digests, and confirmed cost. Schema transformations remain visible as admitted input; they cannot silently replace the retained original.

The application supplies a genuine `Budget` account shared with its primary/child execution and the exact `model:<adapter-id>` grant. The helper never creates an account, copies credit, chooses a provider, reads ambient credentials, invokes tools, retries, performs schema repair, or follows a model continuation. Core-only imports keep provider packages optional. The model adapter is trusted local code; its configured destination/privacy and price-bound assertions must be reviewed by the application.

Every request contains one bounded user message, explicit instructions, no tools, a cooperative signal, and an explicit output-token request bound. Schema checks and optional required local `egressGuards` run before reservation/dispatch. These guards must be local non-recursive admission checks: reentering an auxiliary model helper is not a supported privacy bootstrap. An empty guard list does not establish that the content is safe for the destination. Configure destination-aware local screening before egress; downstream moderation cannot undo an earlier disclosure.

Default limits are 10 seconds, 64 KiB input, 64 KiB complete model response, and 1,024 requested output tokens. Bounds are finite positive safe integers; deadlines cannot exceed the host timer range. The input bound covers the complete serialized request data, not merely the text field. Schema validators and guards share the same deadline. These are cooperative asynchronous bounds, not an operating-system sandbox or a verified provider tokenizer/invoice guarantee.

## Accounting, cancellation, and evidence

After local admission, reserve the configured model cost bound synchronously in the supplied ledger immediately before generation. Concurrent checks use the same ledger, including ancestor call/cost ceilings. Valid known usage settles before validating any provider payload. Malformed envelopes, invalid schema output, forbidden tool calls, continuation state, or extra fields do not erase known costs. `ModelInvocationError` can supply confirmed cost on provider failure. All adapter/validator/guard exceptions are replaced with stable messages; arbitrary framework-shaped exceptions are not trusted public errors.

Unknown or invalid usage retains its full reservation. Over-bound actual usage is recorded exactly and closes ledger admission according to core Budget semantics. Cancellation/timeout stops new dispatch and withholds the result, but cannot kill trusted JavaScript or retract provider work. A late known response still settles the original reservation exactly once; it cannot reopen the already-returned outcome. No late raw payload, token stream, or provider error becomes public evidence.

Successful evidence includes check ID/version, model ID, scope/run/call identity, original/admitted-input/output SHA-256 digests, and actual cost. Digests use canonical JSON and domain separation; they prove payload identity, not authenticity or correctness. Successful results intentionally contain the caller's original/admitted content and must obey application retention/disclosure policy. Failures contain no original content, raw response, protected instructions, or provider messages. No evidence callback or telemetry sink is installed implicitly.

## Language detection and translation

`detectAndTranslate({id,version,detectionModel,translationModel,targetLanguage,budget,permissions,limits?,egressGuards?,minConfidence?})` returns a `ContentProcessor` for an explicitly classified segment document:

```ts
{ segments: [
  { id: "question", kind: "prose", text: "Bonjour" },
  { id: "code", kind: "protected", text: "const customerId = 7;" },
] }
```

The trusted application selects prose and protected spans before this boundary. Classification is not inferred from an untrusted model. Code, paths, resource IDs, secrets, quoted contractual material, and other exact text should remain protected by default. Plain strings are not implicitly classified as prose. Protected segments never enter either auxiliary request and remain unchanged in the result.

Detection and translation use separately configured model adapters and separate accounted requests; applications may deliberately configure the same adapter for both roles. Detection returns a bounded language identifier and confidence. Confidence below the configured threshold (default 0.8) preserves original segments with an explicit low-confidence status and performs no translation call. No prose means no auxiliary call. A successful high-confidence detection is followed by translation of prose segments only; output IDs/order must exactly match the submitted prose map. Omitted, reordered, duplicate, or invented segment IDs fail closed. No unrequested segment or protected-span rewrite is admitted.

The processor preserves the original document, returns the detected language/target, source-mapped derived segments, and both evaluation evidence records when translation occurs. All derived text is model output, not verified meaning. Original and translated views still need required downstream safety checks. Detection/translation failure blocks processing without an automatic fallback. A preserved low-confidence result is not permission to proceed where downstream language support or mandatory checks are unavailable.

## Moderation helper

`createModerationGuard({id,version,model,instructions,budget,permissions,limits?,egressGuards?})` implements `Guard` and additionally exposes `evaluate` for explicit typed evidence inspection. The model returns exactly `{decision: "allow" | "block", categories: string[]}` with bounded category identifiers. `check` returns only the decision, never model reasons or private evidence. Calling both `check` and `evaluate` performs two independently admitted requests; no hidden cross-run result cache exists.

Unavailable, malformed, cancelled, or denied evaluation never becomes `allow`. Existing pipelines can run multiple moderation guards in parallel; all must receive the same externally supplied ledger if they belong to the same spending boundary. The pipeline's own candidate-version/digest evidence remains authoritative for release. A model moderation verdict can be mistaken or manipulated and is not a complete safety boundary.

## Integration limits and verification

Runtime automatic provisioning of the auxiliary ledger, verified identity, provider permissions, operation permits, and retention policy is not implemented in this slice. Passing an unrelated newly created budget would not satisfy shared runtime accounting; the application is responsible for wiring the genuine owning account. The package does not claim durable reconciliation, cross-process atomic accounting, mandatory moderation preallocation, or a paid/live-provider qualification.

Deterministic fake-adapter tests cover genuine-budget/default-deny admission; shared root/child/parallel cost caps; protected-span exclusion; schema and full-envelope validation; known/unknown/overrun and late usage; input/config snapshot immutability; local guard denial; timeouts/cancellation; raw-error redaction; exact segment mapping; low-confidence preservation; and moderation failures. No paid calls or new dependencies are needed.
