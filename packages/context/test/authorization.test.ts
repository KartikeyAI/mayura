import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, type AuthorizationAuditEvent, type Authorizer } from '@mayura/core';
import { assembleContext, createContextCache, type AssembleContextOptions, type ContextCandidate } from '../src/index.js';
const scope = { principalId: 'alice', projectId: 'shop' }; const owners: Authorizer[] = [];
afterEach(() => owners.splice(0).forEach(owner => owner.close()));
function setup() {
  const denied = new Set(['private-source']); const events: AuthorizationAuditEvent[] = [];
  const authorization = createAuthorizer({ policy: { version: 'v1', authorize: request => denied.has(request.resource.id)
    ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null } : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } },
    permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(authorization);
  const candidates: ContextCandidate[] = ['public-source', 'private-source'].map(id => ({ id: `chunk-${id}`, scope, source: { id, revision: '1', kind: 'document' },
    provenance: { reference: 'document://source', observedAt: '2026-10-01T00:00:00.000Z', origin: 'observed', confidence: 1 },
    trust: 'untrusted', sensitivity: 'internal', kind: 'evidence', content: id === 'private-source' ? 'SECRET text' : 'Public text' }));
  const options: AssembleContextOptions = { scope, authorization, policyVersion: 'context-v1', asOf: '2026-10-20T00:00:00.000Z', candidates,
    sources: candidates.map(item => ({ id: item.source.id, revision: '1', status: 'active', scope })), allowedSensitivities: ['internal'], budget: { maxBytes: 100000, maxEstimatedTokens: 100000 } };
  return { options, candidates, denied, authorization, events };
}
describe('document and memory context authorization', () => {
  it('excludes denied document chunks without text, citations, digests or diagnostic identifiers', async () => {
    const { options, events, authorization } = setup(); const assembly = await assembleContext(options); await authorization.flushAudit();
    expect(assembly.selected.map(item => item.source.id)).toEqual(['public-source']);
    expect(assembly.excluded).toEqual([{ position: 1, reason: 'authorization_denied' }]);
    expect(JSON.stringify(assembly)).not.toContain('private-source'); expect(JSON.stringify(assembly)).not.toContain('SECRET');
    expect(events.some(event => event.request?.resource.kind === 'rag_document')).toBe(true); expect(JSON.stringify(events)).not.toContain('SECRET');
  });
  it('does not leak denied source identifiers through stale-revision diagnostics', async () => {
    const { options, candidates } = setup(); candidates[1] = { ...candidates[1]!, source: { ...candidates[1]!.source, revision: 'old' } };
    const result = await assembleContext(options); expect(result.excluded).toContainEqual({ position: 1, reason: 'authorization_denied' }); expect(JSON.stringify(result)).not.toContain('private-source');
  });
  it('denies required continuity evidence rather than silently dropping it', async () => {
    const { options, candidates } = setup(); candidates[1] = { ...candidates[1]!, pinned: true };
    await expect(assembleContext(options)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('uses canonical source identity for memory chunks and guards non-document source kinds too', async () => {
    const { options, candidates, events, authorization } = setup(); candidates[0] = { ...candidates[0]!, source: { ...candidates[0]!.source, kind: 'memory' } };
    candidates[1] = { ...candidates[1]!, source: { ...candidates[1]!.source, kind: 'application' } };
    await assembleContext(options); await authorization.flushAudit();
    expect(events.some(event => event.request?.resource.kind === 'memory' && event.request.resource.id === 'public-source')).toBe(true);
    expect(events.some(event => event.request?.resource.kind === 'rag_document' && event.request.resource.id === 'private-source')).toBe(true);
  });
  it('bypasses warm cached assemblies and never caches a decision across membership changes', async () => {
    const { options, denied } = setup(); const cache = createContextCache();
    const { authorization, ...legacy } = options; await cache.assemble(legacy);
    expect((await cache.assemble({ ...legacy, ...(authorization === undefined ? {} : { authorization }) })).selected).toHaveLength(1);
    denied.clear(); expect((await cache.assemble(options)).selected).toHaveLength(2);
    denied.add('public-source'); expect((await cache.assemble(options)).selected.map(item => item.source.id)).toEqual(['private-source']);
  });
  it('rechecks after hooks and aborts rather than disclosing newly revoked content', async () => {
    const { options, denied } = setup();
    await expect(assembleContext({ ...options, hooks: { afterContextBuild: () => { denied.add('public-source'); return { decision: 'continue' }; } } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const abort = new AbortController(); abort.abort(); await expect(assembleContext({ ...options, signal: abort.signal })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('fails closed on a policy outage without exposing backend diagnostics', async () => {
    const { options } = setup(); const evaluate = vi.fn(() => { throw new Error('SECRET backend'); });
    const authorization = createAuthorizer({ policy: { version: 'v1', authorize: evaluate }, permissions: { allow: ['authz:evaluate'] } }); owners.push(authorization);
    const error = await assembleContext({ ...options, authorization }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED' }); expect(String(error)).not.toContain('SECRET');
  });
});
