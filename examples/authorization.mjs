// Offline RBAC example. Build the workspace first; no network, credentials or model calls are used.
import { createRbacAuthorizer } from 'mayura/authz';

const subject = { principalId: 'alice', projectId: 'shop' };
const authorizer = createRbacAuthorizer({ permissions: { allow: ['authz:evaluate'] },
  policy: { version: 'shop-v1', roles: [
    { id: 'reader', rules: [{ id: 'read-threads', effect: 'allow', actions: ['read'], resource: { kind: 'thread', id: '*' } }] },
    { id: 'reviewer', inherits: ['reader'], rules: [{ id: 'deny-sensitive', effect: 'deny', actions: ['read'], resource: { kind: 'thread', id: 'sensitive' } }] },
  ], bindings: [{ subject, roles: ['reviewer'] }] },
});
try {
  for (const resource of [{ kind: 'thread', id: 'support', scope: subject }, { kind: 'thread', id: 'sensitive', scope: subject },
    { kind: 'thread', id: 'support', scope: { ...subject, projectId: 'other' } }]) {
    console.log(JSON.stringify({ resource: resource.id, project: resource.scope.projectId, decision: await authorizer.authorize(subject, 'read', resource) }));
  }
} finally { authorizer.close(); }
