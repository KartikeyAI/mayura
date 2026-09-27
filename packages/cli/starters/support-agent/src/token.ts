import { randomBytes } from 'node:crypto';
import { newToken, tokenDigest } from './auth.js';

// Prints a new operator token with the SHA-256 digest to configure, and a fresh session secret.
// - Give the operator token to the operator (their secret store); put only its digest in MAYURA_OPERATOR_TOKEN_SHA256.
// - Put the session secret in MAYURA_SESSION_SECRET on every server replica AND in your application backend, which
//   signs customer sessions with it (mintSessionToken in src/session.ts). It never goes to a browser.
const token = newToken();
console.log(JSON.stringify({ token, sha256: tokenDigest(token), sessionSecret: randomBytes(32).toString('hex') }, null, 2));
