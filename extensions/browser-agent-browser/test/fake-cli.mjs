// A stand-in for the agent-browser command line: records its arguments to MAYURA_FAKE_AB_LOG and answers in
// agent-browser's JSON, as MAYURA_FAKE_AB_REPLY says (ok, fail, text, slow, big, bigvalue).
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.MAYURA_FAKE_AB_LOG) appendFileSync(process.env.MAYURA_FAKE_AB_LOG, `${JSON.stringify(args)}\n`);
const mode = process.env.MAYURA_FAKE_AB_REPLY ?? 'ok';
const lifecycle = { launched: false, reused: true };
if (mode === 'slow') setTimeout(() => undefined, 60_000);
else if (mode === 'text') process.stdout.write('Snapshot:\n- heading "Title"\n');
else if (mode === 'fail') { process.stdout.write(JSON.stringify({ success: false, error: 'Element not found: @e9', type: 'not_found' })); process.exitCode = 1; }
else if (mode === 'big') process.stdout.write(JSON.stringify({ success: true, data: { lifecycle, snapshot: `- heading "Title" [ref=e1]\n${'- text "x"\n'.repeat(20_000)}`, refs: {} }, error: null }));
else if (mode === 'bigvalue') process.stdout.write(JSON.stringify({ success: true, data: { lifecycle, text: 'y'.repeat(200_000) }, error: null }));
else {
  const command = args[args.indexOf('--json') + 1];
  const data = command === 'snapshot' ? { snapshot: '- heading "Title" [ref=e1]', refs: { e1: { role: 'heading', name: 'Title' } } }
    : command === 'get' ? { title: 'Example' } : command === 'eval' ? { result: 42 } : { done: command };
  process.stdout.write(JSON.stringify({ success: true, data: { lifecycle, ...data }, error: null }));
}
