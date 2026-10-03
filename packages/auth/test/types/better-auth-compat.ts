// Type check only (never run): a real better-auth 1.7 instance, typed by better-auth's own declarations, fits Mayura's
// better-auth functions with no cast. Checked with skipLibCheck, as applications compile (tsconfig.better-auth.json).
import { betterAuth } from 'better-auth';
import { bearer, jwt, organization } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { createAgentServer } from '@mayura/server';
import { mapCapabilities } from '../../src/index.js';
import { betterAuthApiKeyAuthenticator, betterAuthAuthenticator, betterAuthPermissions, withBetterAuth } from '../../src/better-auth.js';

const auth = betterAuth({ database: undefined as never, plugins: [bearer(), jwt(), organization(), apiKey({ defaultPrefix: 'acme_' })] });

export const sessions = betterAuthAuthenticator(auth, {
  identity: ({ user, session }) => session.activeOrganizationId
    ? { principalId: `user/${user.id}`, projectId: session.activeOrganizationId, agentIds: ['support'], capabilities: ['runs:read'] } : null,
});
export const keys = betterAuthApiKeyAuthenticator(auth, {
  prefix: 'acme_',
  identity: key => ({ principalId: `user/${key.referenceId}`, projectId: 'acme', agentIds: [], capabilities: mapCapabilities(betterAuthPermissions(key.permissions), { 'runs:read': ['runs:read'] }) }),
});
declare const server: ReturnType<typeof createAgentServer>;
export const handler = withBetterAuth(auth, request => server.fetch(request));
