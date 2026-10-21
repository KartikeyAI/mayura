import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorizationAuditEvent, Authorizer } from '@mayura/core';
import { createRbacAuthorizer, createRbacPolicy, type RbacPolicyOptions, type RbacRule } from '../src/index.js';
const subject = { principalId: 'alice', projectId: 'shop' }; const resource = { kind: 'thread' as const, id: 'chat', scope: subject, ownerId: 'alice' };
const owners: Authorizer[] = []; afterEach(() => owners.splice(0).forEach(owner => owner.close()));
const rule = (id: string, effect: RbacRule['effect'] = 'allow', resourceId = '*'): RbacRule => ({ id, effect, actions: ['read'], resource: { kind: 'thread', id: resourceId } });
function policy(): RbacPolicyOptions { return { version: 'v1', roles: [{ id: 'reader', rules: [rule('read-threads')] },
  { id: 'restricted', inherits: ['reader'], rules: [rule('deny-secret', 'deny', 'secret')] }], bindings: [{ subject, roles: ['restricted'] }] }; }
function setup(config = policy()) { const owner = createRbacAuthorizer({ policy: config, permissions: { allow: ['authz:evaluate'] } }); owners.push(owner); return owner; }

describe('scoped role-based access control', () => {
  it('supports inherited rules and explicit deny precedence with stable content-free receipts', async () => {
    const owner = setup(); expect(await owner.authorize(subject, 'read', resource)).toEqual({ effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: 'read-threads' });
    expect(await owner.authorize(subject, 'read', { ...resource, id: 'secret' })).toEqual({ effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: 'deny-secret' });
    await expect(owner.require(subject, 'read', { ...resource, id: 'secret' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  it('denies absent membership, unlisted actions, wrong resource types and cross-scope resources', async () => {
    const owner = setup(); const other = { principalId: 'bob', projectId: 'shop' };
    expect(await owner.authorize(other, 'read', { ...resource, scope: other })).toMatchObject({ effect: 'deny', reason: 'no_match' });
    expect(await owner.authorize(subject, 'update', resource)).toMatchObject({ reason: 'no_match' });
    expect(await owner.authorize(subject, 'read', { ...resource, kind: 'memory' })).toMatchObject({ reason: 'no_match' });
    expect(await owner.authorize(subject, 'read', { ...resource, scope: other })).toMatchObject({ reason: 'scope_mismatch' });
    const project = { ...subject, projectId: 'other' }; expect(await owner.authorize(project, 'read', { ...resource, scope: project })).toMatchObject({ reason: 'no_match' });
    expect(await setup({ version: 'empty', roles: [], bindings: [] }).authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny' });
  });
  it('matches exact ids and explicit ownership constraints without treating missing ownership as a match', async () => {
    const owner = setup({ version: 'owned', roles: [{ id: 'owner', rules: [{ id: 'own-chat', effect: 'allow', actions: ['update'], resource: { kind: 'thread', id: 'chat', owner: 'subject' } }] }], bindings: [{ subject, roles: ['owner'] }] });
    expect(await owner.authorize(subject, 'update', resource)).toMatchObject({ effect: 'allow' });
    for (const next of [{ ...resource, ownerId: 'bob' }, { kind: resource.kind, id: resource.id, scope: subject }, { ...resource, id: 'other' }])
      expect(await owner.authorize(subject, 'update', next)).toMatchObject({ effect: 'deny', reason: 'no_match' });
  });
  it('captures roles and memberships immutably and never accepts request-supplied roles', async () => {
    const roles = [{ id: 'reader', rules: [rule('reader')] }]; const bindings = [{ subject: { ...subject }, roles: ['reader'] }];
    const owner = setup({ version: 'v1', roles, bindings }); roles[0]!.rules.length = 0; bindings[0]!.roles.length = 0; bindings[0]!.subject.principalId = 'bob';
    expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'allow' });
    expect(await owner.authorize({ ...subject, roles: ['reader'] } as never, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'invalid_request' });
  });
  it('refuses cycles, missing references, duplicate identities, wildcards and unbounded configuration', () => {
    const invalid: RbacPolicyOptions[] = [
      { version: 'v1', roles: [{ id: 'a', inherits: ['b'], rules: [] }, { id: 'b', inherits: ['a'], rules: [] }], bindings: [] },
      { version: 'v1', roles: [{ id: 'a', inherits: ['missing'], rules: [] }], bindings: [] },
      { version: 'v1', roles: [], bindings: [{ subject, roles: ['missing'] }] },
      { version: 'v1', roles: [{ id: 'reader', rules: [rule('x'), rule('x')] }], bindings: [] },
      { version: 'v1', roles: [{ id: 'reader', rules: [{ ...rule('x'), actions: ['*'] }] }], bindings: [] },
      { ...policy(), bindings: [{ subject, roles: ['reader'] }, { subject, roles: ['restricted'] }] },
      { ...policy(), limits: { maxRoles: 1 } }, { ...policy(), limits: { maxRules: 1 } }, { ...policy(), limits: { maxPolicyBytes: 20 } },
    ];
    for (const value of invalid) expect(() => createRbacPolicy(value)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
  it('bounds diamond inheritance by its longest path, even when a shared ancestor was already compiled', () => {
    const config = { version: 'v1', roles: [{ id: 'base', rules: [rule('read')] }, { id: 'one', inherits: ['base'], rules: [] }, { id: 'two', inherits: ['one'], rules: [] }],
      bindings: [{ subject, roles: ['two'] }], limits: { maxRoleDepth: 2 } };
    expect(() => createRbacPolicy(config)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
  it('uses the explicit evaluation grant and supports cancellation through the core authorizer', async () => {
    const denied = createRbacAuthorizer({ policy: policy() }); owners.push(denied);
    expect(await denied.authorize(subject, 'read', resource)).toMatchObject({ reason: 'permission_denied' });
    const owner = setup(); const abort = new AbortController(); abort.abort();
    expect(await owner.authorize(subject, 'read', resource, { signal: abort.signal })).toMatchObject({ effect: 'deny', reason: 'cancelled' });
    owner.close(); expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'cancelled' });
  });
});

it('forwards bounded audit settings and receipts through the RBAC authorizer', async () => {
  const events: AuthorizationAuditEvent[] = [];
  const owner = createRbacAuthorizer({ policy: policy(), permissions: { allow: ['authz:evaluate', 'authz:audit'] },
    audit: { sink: event => { events.push(event); }, maxConcurrent: 1, timeoutMs: 20 } }); owners.push(owner);
  await owner.authorize(subject, 'read', { ...resource, id: 'secret' }); await owner.flushAudit();
  expect(events[0]?.decision).toMatchObject({ effect: 'deny', ruleId: 'deny-secret' });
  expect(owner.auditSnapshot()).toMatchObject({ produced: 1, delivered: 1 });
});
