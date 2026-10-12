import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { e2bSandboxes } from '@mayurajs/sandbox-e2b';

// Docker is built in; E2B, Vercel, Daytona, Modal
// and eight more are one package away.
const sandboxes = createSandboxes(e2bSandboxes({ apiKey }), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
});

// No internet unless you allow it.
const sandbox = await sandboxes.create({
  lifetimeMs: 600_000, network: 'none',
});

// Tools that run code in it, once the run is granted
// tool:workspace.exec, sandbox:workspace:exec, effect:write.
const tools = sandboxTools(sandbox, {
  name: 'workspace', exec: true, write: true,
});
