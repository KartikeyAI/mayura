// Live check of @mayurajs/sandbox-agentcore against AWS: the sandbox conformance suite on a real Code Interpreter session.
// Run after pnpm build: node --env-file=.env.live scripts/live/sandbox-agentcore.mjs
// Needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN if temporary) and AWS_REGION, with the
// bedrock-agentcore Code Interpreter permissions.
import { createSandboxes } from '../../packages/mayura/dist/sandbox.js';
import { sandboxConformance } from '../../packages/mayura/dist/sandbox__testing.js';
import { agentCoreSandboxes } from '../../extensions/sandbox-agentcore/dist/index.js';

const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken, AWS_REGION: region } = process.env;
if (!accessKeyId || !secretAccessKey || !region) { console.log('AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION are not set; nothing run.'); process.exit(2); }
const credentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
const sandboxes = createSandboxes(agentCoreSandboxes({ region, credentials }), { maxSandboxes: 1, maxLifetimeMs: 1_800_000 });
const results = [];
try {
  const sandbox = await sandboxes.create({ lifetimeMs: 1_800_000, env: { LIVE_CHECK: 'yes' } });
  // The large-file case moves 3 MiB in command-line pieces: slow, but it shows the limit holds.
  for (const test of sandboxConformance) {
    try { results.push([test.name, await test.run({ sandbox })]); } catch (error) { results.push([test.name, `FAILED: ${error.message}`]); }
  }
  const env = await sandbox.exec(['sh', '-c', 'printf %s "$LIVE_CHECK"; pwd']);
  results.push(['sandbox environment and workdir', env.stdout === 'yes/tmp/workspace\n' ? 'passed' : `FAILED: ${JSON.stringify(env.stdout)}`]);
} finally {
  await sandboxes.close().catch(error => results.push(['close', `FAILED: ${error.message}`]));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL'} ${name}${outcome.startsWith?.('FAILED') ? ` (${outcome})` : ''}`);
process.exit(results.some(([, outcome]) => outcome.startsWith?.('FAILED')) ? 1 : 0);
