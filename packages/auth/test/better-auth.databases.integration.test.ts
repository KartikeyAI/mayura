import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { betterAuthApiKeyAuthenticator, betterAuthAuthenticator } from '../src/better-auth.js';
import { realBetterAuth } from './better-auth-fixture.js';

// better-auth on the databases Mayura's test containers run, each test in a database of its own that it drops:
// MAYURA_TEST_POSTGRES_URL, MAYURA_TEST_MYSQL_URL, MAYURA_TEST_MONGODB_URL.
const postgres = process.env['MAYURA_TEST_POSTGRES_URL'];
const mysql = process.env['MAYURA_TEST_MYSQL_URL'];
const mongo = process.env['MAYURA_TEST_MONGODB_URL'];
const signal = new AbortController().signal;
const name = () => `mayura_ba_${randomUUID().replaceAll('-', '')}`;
const load = (specifier: string) => import(specifier) as Promise<any>;

/** Sign up, authenticate, sign out (refused at once), and an API key, on the database given. */
async function flow(database: unknown, migrate = true) {
  const { auth, signUp } = await realBetterAuth(database, { migrate });
  const { token, userId } = await signUp(`${randomUUID()}@example.com`);
  const sessions = betterAuthAuthenticator(auth, { identity: session => ({ principalId: `user/${session.user.id}`, projectId: 'acme', agentIds: [], capabilities: ['runs:read'] }) });
  expect((await sessions({ token, signal }))?.scope.principalId).toBe(`user/${userId}`);
  await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  expect(await sessions({ token, signal })).toBeNull();
  const { key } = await auth.api.createApiKey({ body: { name: 'ci', permissions: { runs: ['read'] }, userId } }) as { key: string };
  const keys = betterAuthApiKeyAuthenticator(auth, { prefix: 'acme_', identity: found => ({ principalId: `user/${found.referenceId}`, projectId: 'acme', agentIds: [], capabilities: ['runs:read'] }) });
  expect((await keys({ token: key, signal }))?.scope.principalId).toBe(`user/${userId}`);
}

describe.skipIf(postgres === undefined)('better-auth on Postgres', () => {
  it('signs in, signs out and verifies keys', async () => {
    const { Pool } = await load('pg');
    const database = name(); const admin = new Pool({ connectionString: postgres, max: 1 });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(postgres!); url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.href, max: 4 });
    try { await flow(pool); }
    finally { await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
});

describe.skipIf(mysql === undefined)('better-auth on MySQL', () => {
  it('signs in, signs out and verifies keys', async () => {
    const { createPool } = await load('mysql2/promise');
    const database = name(); const admin = createPool({ uri: mysql, connectionLimit: 1 });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(mysql!); url.pathname = `/${database}`;
    const pool = createPool({ uri: url.href, connectionLimit: 4 });
    try { await flow(pool); }
    finally { await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
});

describe.skipIf(mongo === undefined)('better-auth on MongoDB', () => {
  it('signs in, signs out and verifies keys', async () => {
    const { MongoClient } = await load('mongodb');
    const { mongodbAdapter } = await load('better-auth/adapters/mongodb');
    const client = new MongoClient(mongo!); await client.connect();
    const db = client.db(name());
    try { await flow(mongodbAdapter(db, { client }), false); }
    finally { await db.dropDatabase(); await client.close(); }
  });
});
