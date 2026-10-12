---
title: "Mayura with Clerk"
description: "Sign users in with Clerk and let them call your agents: verify Clerk session tokens, map permissions to capabilities, and keep runs and memory per user."
date: 2026-10-12
tags: Clerk, authentication, React, memory
---

*Clerk details checked against Clerk's documentation and `@clerk/react` 6.17.8 on October 12, 2026. Mayura's makers
wrote this guide.*

[Clerk](https://clerk.com) signs users in to your web app and gives each session a short-lived JWT. Mayura's server
needs to know who is calling and what they may do. `@mayurajs/auth-clerk` connects the two: it verifies Clerk session
tokens on your agent server and hands you the user, their organization and their permissions, and you decide what
that means for your agents.

Nothing is allowed by default. A valid Clerk token proves who someone is; your mapping decides which agents they may
run, and the identity it returns decides whose runs and whose memory they can reach.

## What you'll build

- An agent server that accepts Clerk session tokens as bearer tokens, and refuses everything else.
- A mapping from Clerk organization permissions to Mayura capabilities.
- An agent whose memory tools read and write only the signed-in user's records.
- A React client that calls the server with the user's current token.
- A test of the mapping with real signatures and no network.

## 1. Install

```bash
npm install mayura @mayurajs/auth-clerk
```

The package has no dependency besides `mayura`, and uses no Clerk SDK. It verifies tokens with `mayura/auth`'s own JWT
verifier, which uses WebCrypto alone, so the same code runs on Node, Bun, Deno, Cloudflare Workers and Vercel Edge.

Nothing secret is needed on the server. Copy your instance's **publishable key** (`pk_live_...` or `pk_test_...`) from
the **API keys** page of the Clerk dashboard. Your Frontend API URL, which issues the tokens and publishes the keys that
sign them, is encoded in it.

## 2. Map Clerk users to identities

The authenticator takes three things: your publishable key, the origins your users sign in from, and an `identity`
function that turns a verified Clerk session into a Mayura identity, or `null` to refuse it.

```ts
// src/auth.ts
import { mapCapabilities, principalId, type IdentityGrant } from 'mayura/auth';
import { clerkAuthenticator, type ClerkSession } from '@mayurajs/auth-clerk';

/** What a signed-in Clerk user may do here. */
export function identity(session: ClerkSession): IdentityGrant | null {
  if (!session.orgId) return null; // only members of an active organization
  const capabilities = mapCapabilities(session.orgPermissions, {
    'org:agents:use': ['runs:submit', 'runs:read', 'runs:cancel'],
    'org:agents:operate': ['workflows:read', 'workflows:control'],
  });
  return {
    principalId: principalId('clerk', session.userId),
    projectId: session.orgId,
    agentIds: ['support.assistant'],
    // Someone impersonating the user from Clerk's dashboard may look, not act.
    capabilities: session.actor ? capabilities.filter(capability => capability === 'runs:read') : capabilities,
  };
}

export const authenticate = clerkAuthenticator({
  publishableKey: process.env['CLERK_PUBLISHABLE_KEY'] ?? '',
  authorizedParties: ['https://app.example.com'],
  identity,
});
```

Each field of the returned identity does a specific job:

- **`principalId`** is who the caller is. `principalId('clerk', 'user_2x...')` gives `clerk/user_2x...`. The namespace
  keeps Clerk users apart from callers you add later, such as API keys, and any subject with characters the server
  does not accept is turned into a stable SHA-256 form instead.
- **`projectId`** is the tenant. Using the active organization means one user in two organizations has two separate
  scopes, with separate runs and separate memory. An app without organizations can use a fixed value instead, such
  as `'app'`, and drop the `orgId` check.
- **`agentIds`** lists the agents this caller may see and run. Any other agent id answers 404.
- **`capabilities`** are what the caller may do. `mapCapabilities` reads Clerk's permission names through your table,
  and a permission missing from the table grants nothing. The
  [capabilities table](../../../docs/guides/server-and-client.md#authentication-and-capabilities) lists them all.

The `session` object carries `userId`, `sessionId`, `status`, `orgId`, `orgSlug`, `orgRole`, `orgPermissions`, `actor`
and the verified `claims`. Clerk's current (version 2) tokens pack organization permissions into feature bitmasks; the
package decodes them the way Clerk's own SDK does, so `orgPermissions` holds names such as `org:agents:use`.

An identity lasts at most 60 seconds (`maxIdentityMs`), and never longer than the token. Clerk's session tokens are
short-lived to begin with: its frontend SDK keeps replacing them with fresh ones.

## 3. What is checked

Before `identity` is called, a token must pass every check Clerk lists for verifying session tokens by hand:

- **Signature and issuer.** RS256 only, issued by your Frontend API, signed by a key from
  `<frontendApi>/.well-known/jwks.json`. A token signed by any other algorithm or key is refused.
- **Times.** The token must carry `exp` and be unexpired, with 5 seconds of clock skew allowed (`clockSkewMs`).
- **Authorized party.** Clerk tokens carry no audience. Instead, `azp` names the origin the token was made for.
  Clerk's documentation warns that not checking it can open your application to CSRF attacks, so
  `authorizedParties` is required: a token without `azp`, or for an origin not in the list, is refused. List
  `http://localhost:3000` too while you develop. `authorizedParties: false` turns the check off; use it only where no
  browser is involved.
- **Session.** A token needs `sub` and `sid`. A session Clerk marks `pending` (the user signed up but has not, for
  example, chosen an organization yet) is refused unless you pass `allowPending: true`.

The authenticator fetches your instance's keys once, keeps them for the JWKS response's `max-age` (at most 10
minutes), and refetches at most every 30 seconds when a token names a key it has not seen, which is how rotated keys
are found. To verify with no network at all, copy the **JWKS public key** (PEM) from the same dashboard page and pass
it as `jwtKey`.

When things go wrong, the answers stay distinct. A token that fails any check, or that `identity` refuses, gets 401
`AUTH_INVALID`. If the keys cannot be fetched and none are cached, the server answers 503 `AUTH_UNAVAILABLE`: it never
treats an outage as a valid caller or as a bad token. A mapping that returns something the server cannot use, such as
a capability it does not know, is a configuration error: it also answers 503 and never lets the caller in.

## 4. Keep runs and memory per user

The server keys every run by the caller's scope, `{ principalId, projectId }`. A user can read, stream or cancel only
runs started under their own scope; anyone else gets 404, as if the run did not exist. Tools receive the same scope as
`context.scope`, so they can load that user's data and nothing else.

That is all it takes to scope [memory](../../../docs/guides/memory-and-context.md): build the memory instance from
`context.scope` inside the tool, and never take a user id as tool input. A model then has no way to name another user.

```ts
// src/server.ts
import { createHash } from 'node:crypto';
import { defineAgent, defineTool, z } from 'mayura';
import { createNativeMemory } from 'mayura/memory';
import { openAIResponses } from 'mayura/provider-openai';
import { listenProductionServer } from 'mayura/server-node';
import { createPostgresStore } from 'mayura/storage-postgres';
import { authenticate } from './auth.js';

const store = createPostgresStore({ connectionString: process.env['DATABASE_URL']! });
await store.initialize();
await store.memory.initialize();

const recall = defineTool({
  id: 'memory.recall', version: '1', effects: 'read', capabilities: ['memory:read'],
  description: 'Look up what you remembered about the signed-in user.',
  input: z.object({ query: z.string().min(1).max(200) }),
  output: z.object({ notes: z.array(z.string()) }),
  execute: async ({ query }, context) => {
    const memory = createNativeMemory({ store, scope: context.scope, permissions: { allow: ['memory:read'] } });
    const { hits } = await memory.search(query, { limit: 10 });
    return { notes: hits.map(hit => hit.record.content) };
  },
});

const remember = defineTool({
  id: 'memory.remember', version: '1', effects: 'write', capabilities: ['memory:write'],
  description: 'Remember one lasting fact or preference the user asked you to remember.',
  input: z.object({ fact: z.string().min(3).max(500) }),
  output: z.object({ noteId: z.string() }),
  execute: async ({ fact }, context) => {
    const sha256 = createHash('sha256').update(fact).digest('hex');
    const noteId = `note-${sha256.slice(0, 24)}`;
    const memory = createNativeMemory({ store, scope: context.scope, permissions: { allow: ['memory:write'] } });
    await memory.add({ id: noteId, content: fact, category: 'preference', provenance: {
      sourceId: 'chat', reference: `run/${context.runId}`, revision: '1', sha256,
      author: context.scope.principalId, observedAt: new Date().toISOString(), origin: 'observed', confidence: 1 } });
    return { noteId };
  },
});

const assistant = defineAgent({
  id: 'support.assistant', version: '1',
  instructions: 'Help the signed-in user. Check memory.recall first; use memory.remember only when they ask you to remember something.',
  model: openAIResponses({
    apiKey: process.env['OPENAI_API_KEY']!, model: process.env['OPENAI_MODEL']!, maxCostMicros: 20_000,
    pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000 },
  }),
  tools: [recall, remember],
  input: z.object({ message: z.string().min(1).max(4_000) }),
  output: z.object({ reply: z.string() }),
});

const server = await listenProductionServer({
  publicOrigin: 'https://agents.example.com',
  allowedOrigins: ['https://app.example.com'],
  hostname: '0.0.0.0', port: 8080, tls: { terminatedBy: 'proxy' },
  agents: [{
    agent: assistant,
    permissions: { allow: ['model:openai.responses', 'tool:memory.recall', 'tool:memory.remember',
      'memory:read', 'memory:write', 'effect:read', 'effect:write'] },
    limits: { maxDurationMs: 60_000, maxCostMicros: 100_000 },
  }],
  authenticate,
});
```

Set the pricing to your model's current prices. Two settings here are about the browser, not Clerk:

- **`allowedOrigins`** lets pages on `https://app.example.com` call an API served from another origin. A page served
  from `publicOrigin` itself needs no entry. CORS is not authentication; every call still needs a valid token.
- **`authorizedParties`** in `src/auth.ts` is about the token, not the request: it refuses tokens Clerk issued to any
  other origin. Usually both list the same origins.

If you serve the API from your web app instead, as in [Mayura with Next.js](nextjs.md), use `createAgentServer` with
`mounted: true` and the same `authenticate`. Since everything is then same-origin, `allowedOrigins` is not needed.

## 5. Call the API from the browser

`mayura/client` takes a `token` function and calls it before every request, so it can hand over whatever token is
current. With Clerk's React SDK, that is `getToken()` from `useAuth()`:

```tsx
// src/use-agents.ts
import { useMemo } from 'react';
import { useAuth } from '@clerk/react';
import { createClient } from 'mayura/client';

export function useAgents() {
  const { getToken } = useAuth();
  return useMemo(() => createClient({
    baseUrl: 'https://agents.example.com',
    token: async () => {
      const token = await getToken();
      if (!token) throw new Error('Not signed in.');
      return token;
    },
  }), [getToken]);
}
```

A component then submits runs and follows them exactly as in
[Mayura with Next.js](nextjs.md#4-show-a-live-run-in-react):

```tsx
import { useAgents } from './use-agents.js';

export function AskButton() {
  const client = useAgents();
  async function ask(): Promise<void> {
    const run = await client.submit('support.assistant', { message: 'Remember that I prefer email.' },
      { idempotencyKey: crypto.randomUUID() });
    for await (const event of run.events()) console.log(event.type);
  }
  return <button onClick={() => void ask()}>Ask</button>;
}
```

Short tokens and long streams fit together. An event stream never outlives the identity it was opened with, so the
server ends it within a minute. `run.events()` then reconnects from the last event it saw, calls `token()` again, and
gets Clerk's current token. An expired identity (`AUTH_EXPIRED`) is retried rather than thrown, for this reason.

Keep the Clerk token in the browser and the provider keys on the server. Nothing in the browser bundle grants
anything: the token says who the user is, and only your `identity` function decides what that allows.

## 6. Test the mapping without Clerk

`mayura/auth/testing` has a test issuer that makes RS256 keys, signs tokens and serves its JWKS through a fake
`fetch`. Point the authenticator at it with a publishable key for a test host, and your mapping runs against real
signatures, offline:

```ts
import { describe, expect, it } from 'vitest';
import { testIssuer } from 'mayura/auth/testing';
import { clerkAuthenticator } from '@mayurajs/auth-clerk';
import { identity } from './auth.js';

describe('Clerk identity', () => {
  it('lets organization members in and refuses everyone else', async () => {
    const clerk = await testIssuer({ issuer: 'https://clerk.example.com', algorithm: 'RS256' });
    const authenticate = clerkAuthenticator({
      publishableKey: `pk_test_${btoa('clerk.example.com$')}`,
      authorizedParties: ['https://app.example.com'],
      fetch: clerk.fetch,
      identity,
    });
    const signal = new AbortController().signal;
    const claims = { sub: 'user_1', sid: 'sess_1', azp: 'https://app.example.com', v: 1, org_id: 'org_1', org_permissions: ['org:agents:use'] };

    const member = await authenticate({ token: await clerk.sign(claims), signal });
    expect(member?.scope).toEqual({ principalId: 'clerk/user_1', projectId: 'org_1' });
    expect(member?.capabilities).toContain('runs:submit');

    expect(await authenticate({ token: await clerk.sign({ ...claims, org_id: undefined }), signal })).toBeNull();
    expect(await authenticate({ token: await clerk.sign({ ...claims, azp: 'https://evil.example.com' }), signal })).toBeNull();
  });
});
```

The test uses Clerk's older version 1 claims (`org_id`, `org_permissions`), which are simpler to write by hand; the
package reads both versions. Add cases for every rule your mapping has, especially the refusals.

## Good to know

- **The authenticator only looks at tokens from your instance.** With `chainAuthenticators` from `mayura/auth`, you
  can accept Clerk users and API keys from `mayura/keys` on the same server; each token goes to the authenticator that
  recognizes its issuer or prefix. See [Authentication and API keys](../../../docs/guides/authentication.md).
- **Signing out takes effect within a token's life.** The server checks tokens, not sessions, so a revoked session's
  last token works until it expires. Clerk tokens are short, and an open event stream ends with the identity it was
  opened with, at most 60 seconds later.
- **How it is tested.** Unit tests sign real RS256 tokens and check every refusal listed above. A live check fetched
  and checked the signing keys of a real Clerk instance on October 6, 2026; a real session token has not been verified
  with it yet. See [Clerk session tokens](../../../docs/integrations/auth-clerk.md#how-it-is-tested).

## Next steps

- [Clerk session tokens](../../../docs/integrations/auth-clerk.md): every option, claim and error.
- [Memory and context](../../../docs/guides/memory-and-context.md): search, versions and provenance.
- [Server and client](../../../docs/guides/server-and-client.md): streaming, idempotent submission and errors.

## Sources

- Clerk, [Session tokens](https://clerk.com/docs/guides/sessions/session-tokens): claims, including `azp`, `sid`,
  `sts`, `v`, `o` and `fea`.
- Clerk, [Manual JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification): the checks, the
  CSRF warning about `azp`, and `pending` sessions.
- Clerk, [`useAuth()`](https://clerk.com/docs/react/reference/hooks/use-auth): `getToken()` in `@clerk/react`.
