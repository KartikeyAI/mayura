import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sendDelivery } from './signing.js';
import { sampleNames, ticketCreatedEvent, type SampleName } from './tracker/samples.js';

// Plays the tracker: signs one `ticket.created` delivery and posts it to the webhook ingress.
//   npm run send-sample -- [outage|billing|docs|feature] [--delivery <id>] [--stale] [--forged]
// --delivery reuses a delivery id (a retry or a replay), --stale signs with a timestamp ten minutes old, and --forged
// signs with the wrong secret. The URL and secret come from WEBHOOK_URL and WEBHOOK_SECRET, or from the file
// `npm run dev` writes.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  delivery: { type: 'string' }, stale: { type: 'boolean', default: false }, forged: { type: 'boolean', default: false } } });
const name = (positionals[0] ?? 'outage') as SampleName;
if (!sampleNames.includes(name)) throw new Error(`Unknown sample "${name}". Choose one of: ${sampleNames.join(', ')}.`);

const target = z.object({ url: z.url({ protocol: /^https?$/u }), secret: z.string().min(32) });
const fromEnvironment = process.env['WEBHOOK_URL'] && process.env['WEBHOOK_SECRET']
  ? { url: process.env['WEBHOOK_URL'], secret: process.env['WEBHOOK_SECRET'] } : undefined;
let settings;
try { settings = target.parse(fromEnvironment ?? JSON.parse(await readFile('.data/dev-webhook.json', 'utf8'))); }
catch { throw new Error('Start `npm run dev` first, or set WEBHOOK_URL and WEBHOOK_SECRET.'); }

const deliveryId = values.delivery ?? `sample-${name}-${randomBytes(4).toString('hex')}`;
const secret = values.forged ? randomBytes(32).toString('hex') : settings.secret;
const timestampMs = Date.now() - (values.stale ? 600_000 : 0);
const { status, body } = await sendDelivery(settings.url, secret, { deliveryId, event: ticketCreatedEvent(name), timestampMs });
console.log(JSON.stringify({ deliveryId, status, response: body }, null, 2));
