import { assertPositiveInteger, freezeJson, jsonValue, MayuraError, type JsonValue, type Scope } from '@mayura/core';
import type { AssembleContextOptions, ContextAssembly, ContextCandidate, ContextExclusion, ContextItem, ContextKind, ContextProvenance, ContextSource, ContextTrust, ContextValidity, ExclusionReason, Sensitivity, SourceKind, SourceState, TokenEstimator, UpstreamEvidence } from './contracts.js';

const encoder = new TextEncoder();
const inputBytes = 4_194_304;
const protectedKinds = new Set<ContextKind>(['hard_constraint', 'pending_approval', 'unresolved_blocker', 'outstanding_task']);
const kinds = new Set<ContextKind>(['evidence', 'instruction', ...protectedKinds]);
const sensitivities = new Set<Sensitivity>(['public', 'internal', 'confidential', 'restricted']);
const trusts = new Set<ContextTrust>(['untrusted', 'reviewed', 'trusted']);
const sourceKinds = new Set<SourceKind>(['document', 'conversation', 'memory', 'artifact', 'repository', 'tool', 'application']);

/** A transparent heuristic; provider framing/tokenization must still be admitted separately. */
export const byteTokenEstimator: TokenEstimator = Object.freeze({ id: 'utf8-bytes-v1', estimate: (text: string) => encoder.encode(text).length });

function invalid(message: string): never { throw new MayuraError('INVALID_INPUT', message); }
function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return invalid(`${label} must be a bounded nonempty string.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Context metadata must be a plain JSON object.');
  return value as Record<string, unknown>;
}
function scopeOf(value: unknown): Scope {
  const scope = object(value);
  return Object.freeze({ principalId: text(scope['principalId'], 'principalId'), projectId: text(scope['projectId'], 'projectId') });
}
function sameScope(one: Scope, two: Scope): boolean { return one.principalId === two.principalId && one.projectId === two.projectId; }
function safeJson(value: unknown, maxBytes = inputBytes): JsonValue {
  try { return freezeJson(jsonValue(value, { maxBytes })); }
  catch { return invalid('Context input must satisfy plain-JSON and input-size limits.'); }
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
async function hash(domain: string, value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`${domain}\0${value}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function canonicalTime(value: unknown, label = 'observedAt'): string {
  const timestamp = text(value, label, 32);
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== timestamp) return invalid(`${label} must be a canonical UTC ISO timestamp.`);
  return timestamp;
}
function upstreamOf(value: unknown): UpstreamEvidence {
  const supplied = object(value);
  const sha256 = supplied['sha256'];
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return invalid('Upstream evidence SHA-256 must contain 64 lowercase hexadecimal characters.');
  return Object.freeze({ sourceId: text(supplied['sourceId'], 'upstream.sourceId'), revision: text(supplied['revision'], 'upstream.revision'), sha256 });
}
function validityOf(value: unknown): ContextValidity {
  const supplied = object(value);
  const from = canonicalTime(supplied['from'], 'validity.from');
  const until = supplied['until'] === null ? null : canonicalTime(supplied['until'], 'validity.until');
  if (until !== null && Date.parse(until) <= Date.parse(from)) return invalid('Context validity must end after it begins.');
  return Object.freeze({ from, until });
}
function readCandidate(value: Record<string, unknown>, scope: Scope): ContextCandidate & { readonly priority: number; readonly pinned: boolean; readonly required: boolean } {
  const sourceInput = object(value['source']);
  const source: ContextSource = Object.freeze({ id: text(sourceInput['id'], 'source.id'), revision: text(sourceInput['revision'], 'source.revision'), kind: sourceInput['kind'] as SourceKind });
  if (!sourceKinds.has(source.kind)) return invalid('Unknown context source kind.');
  const supplied = object(value['provenance']);
  const confidence = supplied['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return invalid('Provenance confidence must be between zero and one.');
  const origin = supplied['origin'];
  if (origin !== 'observed' && origin !== 'inferred') return invalid('Unknown provenance origin.');
  const provenance: ContextProvenance = Object.freeze({ reference: text(supplied['reference'], 'provenance.reference', 2_048), observedAt: canonicalTime(supplied['observedAt']), origin, confidence,
    ...(supplied['author'] === undefined ? {} : { author: text(supplied['author'], 'provenance.author') }),
    ...(supplied['upstream'] === undefined ? {} : { upstream: upstreamOf(supplied['upstream']) }),
  });
  const kind = value['kind'] as ContextKind; const trust = value['trust'] as ContextTrust; const sensitivity = value['sensitivity'] as Sensitivity;
  if (!kinds.has(kind) || !trusts.has(trust) || !sensitivities.has(sensitivity)) return invalid('Unknown context category, trust, or sensitivity.');
  const priority = value['priority'] ?? 0; const pinned = value['pinned'] ?? false;
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || Math.abs(priority) > 1_000_000 || typeof pinned !== 'boolean') return invalid('Context priority or pin metadata is invalid.');
  return Object.freeze({ id: text(value['id'], 'candidate.id'), scope, source, provenance, kind, trust, sensitivity, priority, pinned,
    ...(value['validity'] === undefined ? {} : { validity: validityOf(value['validity']) }),
    required: pinned || protectedKinds.has(kind), content: safeJson(value['content'], 262_144),
  });
}

/** Select current authorized evidence without silently dropping required continuity items or inventing summaries. */
export async function assembleContext(options: AssembleContextOptions): Promise<ContextAssembly> {
  // Snapshot all caller-controlled JSON before the first await; later mutations cannot change admission.
  const suppliedAsOf = options.asOf;
  const asOf = canonicalTime(suppliedAsOf === undefined ? new Date().toISOString() : suppliedAsOf, 'asOf');
  const asOfTime = Date.parse(asOf);
  const scope = scopeOf(safeJson(options.scope));
  const policyVersion = text(options.policyVersion, 'policyVersion', 128);
  const rawCandidates = safeJson(options.candidates);
  const rawSources = safeJson(options.sources, 1_048_576);
  if (!Array.isArray(rawCandidates) || rawCandidates.length > 512 || !Array.isArray(rawSources) || rawSources.length > 1_024) return invalid('At most 512 context candidates and 1024 source states are supported per assembly.');
  const allowedInput = safeJson(options.allowedSensitivities, 256);
  if (!Array.isArray(allowedInput) || allowedInput.some((value) => typeof value !== 'string' || !sensitivities.has(value as Sensitivity))) return invalid('An explicit sensitivity allow-list is required.');
  const allowed = new Set(allowedInput as Sensitivity[]);
  const suppliedBudget = object(safeJson(options.budget, 1_024));
  const maxBytes = suppliedBudget['maxBytes'] as number; const maxEstimatedTokens = suppliedBudget['maxEstimatedTokens'] as number;
  assertPositiveInteger(maxBytes, 'maxBytes'); assertPositiveInteger(maxEstimatedTokens, 'maxEstimatedTokens');
  const reservedBytes = suppliedBudget['reservedBytes'] ?? 0; const reservedTokens = suppliedBudget['reservedTokens'] ?? 0;
  if (typeof reservedBytes !== 'number' || !Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || typeof reservedTokens !== 'number' || !Number.isSafeInteger(reservedTokens) || reservedTokens < 0) return invalid('Reserved capacity must be non-negative safe integers.');
  if (reservedBytes > maxBytes || reservedTokens > maxEstimatedTokens) throw new MayuraError('LIMIT_EXCEEDED', 'Reserved capacity exhausts the configured context budget.');
  const estimatorInput = options.estimator ?? byteTokenEstimator;
  const estimatorId = text(estimatorInput.id, 'estimator.id', 128);
  if (typeof estimatorInput.estimate !== 'function') return invalid('A callable local token estimator is required.');
  const estimate = estimatorInput.estimate.bind(estimatorInput);
  const sources = new Map<string, SourceState>();
  for (const raw of rawSources) {
    const value = object(raw); const sourceScope = scopeOf(value['scope']);
    if (!sameScope(sourceScope, scope)) continue;
    const id = text(value['id'], 'source.id'); const revision = text(value['revision'], 'source.revision'); const status = value['status'];
    if (status !== 'active' && status !== 'deleted') return invalid('Unknown current source state.');
    if (sources.has(id)) throw new MayuraError('CONFLICT', 'Current-scope source states must have unique IDs.');
    sources.set(id, Object.freeze({ scope: sourceScope, id, revision, status }));
  }
  const excluded: ContextExclusion[] = [];
  const eligible: { readonly item: ReturnType<typeof readCandidate>; readonly position: number }[] = [];
  const candidateIds = new Set<string>();
  for (const [position, raw] of rawCandidates.entries()) {
    const value = object(raw); const candidateScope = scopeOf(value['scope']);
    if (!sameScope(candidateScope, scope)) { excluded.push(Object.freeze({ position, reason: 'scope_mismatch' })); continue; }
    const candidate = readCandidate(value, candidateScope);
    if (candidateIds.has(candidate.id)) throw new MayuraError('CONFLICT', 'Current-scope context candidates must have unique IDs.');
    candidateIds.add(candidate.id);
    let reason: ExclusionReason | undefined;
    const current = sources.get(candidate.source.id);
    if (!allowed.has(candidate.sensitivity)) reason = 'sensitivity_denied';
    else if (!current) reason = 'source_missing';
    else if (current.status === 'deleted') reason = 'source_deleted';
    else if (current.revision !== candidate.source.revision) reason = 'stale_revision';
    else if (candidate.validity && Date.parse(candidate.validity.from) > asOfTime) reason = 'not_yet_valid';
    else if (candidate.validity?.until !== undefined && candidate.validity.until !== null && Date.parse(candidate.validity.until) <= asOfTime) reason = 'expired';
    if (reason) {
      if (candidate.required) throw new MayuraError(reason === 'sensitivity_denied' ? 'PERMISSION_DENIED' : 'CONFLICT', 'A required continuity item is unavailable, stale, deleted, outside its validity interval, or denied; refresh or resolve it explicitly.');
      excluded.push(Object.freeze({ position, reason, ...(reason === 'sensitivity_denied' ? {} : { candidateId: candidate.id, sourceId: candidate.source.id, revision: candidate.source.revision }) }));
    } else eligible.push({ item: candidate, position });
  }
  eligible.sort((left, right) => {
    const one = left.item; const two = right.item;
    if (one.required !== two.required) return one.required ? -1 : 1;
    if (one.priority !== two.priority) return two.priority - one.priority;
    if (one.provenance.observedAt !== two.provenance.observedAt) return Date.parse(one.provenance.observedAt) > Date.parse(two.provenance.observedAt) ? -1 : 1;
    return one.id < two.id ? -1 : one.id > two.id ? 1 : 0;
  });
  const candidates = await Promise.all(eligible.map(async ({ item, position }) => ({ position, item: Object.freeze({ ...item, contentDigest: await hash('mayura:context-content:v1', canonical(item.content)) }) as ContextItem })));
  const encode = (items: readonly ContextItem[]): string => canonical(jsonValue({ format: 1, scope, policyVersion, asOf, items }, { maxBytes: 8_388_608 }));
  const measure = (items: readonly ContextItem[]) => {
    const serialized = encode(items); const bytes = encoder.encode(serialized).length;
    let estimatedTokens: number;
    try { estimatedTokens = estimate(serialized); }
    catch { throw new MayuraError('INVALID_CONFIG', 'The token estimator failed; raw exception details are withheld.'); }
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) throw new MayuraError('INVALID_CONFIG', 'The token estimator must return a non-negative safe integer.');
    const reason = bytes > maxBytes - reservedBytes ? 'byte_budget' as const : estimatedTokens > maxEstimatedTokens - reservedTokens ? 'token_budget' as const : undefined;
    return { serialized, bytes, estimatedTokens, reason };
  };
  const selected = candidates.filter(({ item }) => item.required).map(({ item }) => item);
  let measured = measure(selected);
  if (measured.reason) throw new MayuraError('LIMIT_EXCEEDED', 'Required continuity items and context framing do not fit the reserved context budget.');
  for (const candidate of candidates) {
    if (candidate.item.required) continue;
    const next = measure([...selected, candidate.item]);
    if (next.reason) excluded.push(Object.freeze({ position: candidate.position, reason: next.reason,
      candidateId: candidate.item.id, sourceId: candidate.item.source.id, revision: candidate.item.source.revision,
    }));
    else { selected.push(candidate.item); measured = next; }
  }
  excluded.sort((one, two) => one.position - two.position);
  const budget = { maxBytes, maxEstimatedTokens, reservedBytes, reservedTokens };
  const fingerprint = await hash('mayura:context-assembly:v1', canonical(jsonValue({ serialized: measured.serialized, budget, estimatorId, allowedSensitivities: [...allowed].sort() }, { maxBytes: 16_777_216 })));
  return Object.freeze({ scope, policyVersion, asOf, selected: Object.freeze(selected), excluded: Object.freeze(excluded), serialized: measured.serialized, fingerprint,
    usage: Object.freeze({ bytes: measured.bytes, estimatedTokens: measured.estimatedTokens, reservedBytes, reservedTokens, maxBytes, maxEstimatedTokens, estimatorId }),
  });
}
