# SQL identity integrity

## Scope and decision

The shared SQL identifier validator and the driver-free workflow format-2 identity validator must reject ill-formed UTF-16 strings: a high surrogate without its following low surrogate, or a low surrogate without its preceding high surrogate. UTF-8 encoders replace these units with U+FFFD, so accepting them as database identities can collapse distinct JavaScript strings into the same SQL key. Rejection must occur before a SQL operation is admitted; validation errors must not echo the offending identity.

This is a narrow admission hardening change, not a storage-format change or a migration. Existing records are not rewritten or normalized, and no claim is made to recover the original identity of previously encoded malformed inputs. Callers supplying malformed identity strings now receive `INVALID_INPUT`; persisted workflow identity validation retains its existing `CONFLICT` integrity error.

## Boundaries

- Apply the check only in `storage-sql`'s `identifier` helper and `storage-contracts`' format-2 `identity` helper. Their existing callers cover aggregate/scheduler SQL identities, workflow resource identities, run identities, and receipt call identities.
- Preserve exact strings: no NFC/NFD normalization, case folding, trimming, replacement characters, or automatic repair. A literal U+FFFD remains a valid, distinct identity.
- Preserve valid supplementary Unicode code points encoded as surrogate pairs, including the existing 256 UTF-8-byte limit for general SQL identities and the existing explicit larger receipt limit. Existing empty-string, NUL, byte-length, and field-shape checks remain unchanged.
- Do not reject surrogate units throughout arbitrary JSON payloads or alter canonical JSON/hash material. JSON encodes such payload content as escaped units without creating SQL identity aliases. Text-only metadata that does not use these identity helpers is outside this change.
- Keep the existing package boundaries and dependencies. The portable contracts implementation must not depend on Node-specific APIs.

## Verification before integration

Capture failing tests before editing the two production helpers. Unit tests exercise high/low/reversed/interrupted surrogate sequences, valid pairs at byte limits, exact U+FFFD behavior, normalization distinctions, and unchanged payload/hash handling. Paired real SQLite/PostgreSQL tests exercise aggregate writes/reads, scheduler reservations/resource keys/worker identities, unchanged state and event history after rejection, and valid Unicode persistence after reopen. Re-run the focused tests after the helper changes, followed by the normal type, full-suite, and packaged-consumer gates under the main integration task.
