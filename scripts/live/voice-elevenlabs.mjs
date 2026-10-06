// Live check of @mayurajs/voice-elevenlabs: speech with eleven_v3, then Scribe transcribes it. Run after pnpm build:
//   node --env-file=.env.live scripts/live/voice-elevenlabs.mjs  (needs ELEVENLABS_API_KEY)
import { report, voiceChecks } from './voice-checks.mjs';
const { elevenlabsVoice } = await import(new URL('../../extensions/voice-elevenlabs/dist/index.js', import.meta.url).href);

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) { console.log('ELEVENLABS_API_KEY is not set; nothing run.'); process.exit(2); }
report(await voiceChecks({ providers: [elevenlabsVoice({ apiKey })], speak: { id: 'elevenlabs/eleven_v3', voice: 'JBFqnCBsd6RMkjVDRZzb' }, transcribe: { id: 'elevenlabs/scribe_v2' } }));
