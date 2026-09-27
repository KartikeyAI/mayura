import { newToken, tokenDigest } from './auth.js';

// Prints a new bearer token and the SHA-256 digest to configure. Give the token to the operator (store it in their
// secret manager); put only the digest in MAYURA_OPERATOR_TOKEN_SHA256. The same command makes a strong
// WEBHOOK_SECRET: use the printed token as the secret you share with the tracker.
const token = newToken();
console.log(JSON.stringify({ token, sha256: tokenDigest(token) }, null, 2));
