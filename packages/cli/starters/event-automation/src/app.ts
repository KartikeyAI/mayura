import { defineMayuraApplication } from '@mayura/cli';
import { loadConfig } from './config.js';
import { startServer } from './server.js';
import { openServices, type Services } from './services.js';
import { createTicketWorker } from './worker.js';

// The production entry point for `mayura serve`, `mayura worker` and `mayura migrate` (see package.json scripts).
// Run the server (API + webhook ingress) and the worker as separate processes; both read the same environment.
const config = await loadConfig();
let services: Promise<Services> | undefined;
const ready = (): Promise<Services> => (services ??= openServices(config));

export default defineMayuraApplication({
  async server() { return startServer(config, await ready()); },
  async worker() { return createTicketWorker(config, await ready()).worker; },
  // Storage schema version 1 is the baseline. Later releases ship explicit, one-way, versioned migrations here.
  async migrate() { await ready(); return { schemaVersion: 1 }; },
  async shutdown() { if (services) await (await services).close(); },
});
