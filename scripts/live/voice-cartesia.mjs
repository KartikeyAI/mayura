// Live check of @mayurajs/voice-cartesia: speech with Sonic 3.6, then Ink-Whisper transcribes it. Run after pnpm build:
//   node --env-file=.env.live scripts/live/voice-cartesia.mjs  (needs CARTESIA_API_KEY)
import { report, voiceChecks } from './voice-checks.mjs';
const { cartesiaVoice } = await import(new URL('../../extensions/voice-cartesia/dist/index.js', import.meta.url).href);

const apiKey = process.env.CARTESIA_API_KEY;
if (!apiKey) { console.log('CARTESIA_API_KEY is not set; nothing run.'); process.exit(2); }
report(await voiceChecks({ providers: [cartesiaVoice({ apiKey })], speak: { id: 'cartesia/sonic-3.6', voice: 'a0e99841-438c-4a64-b679-ae501e7d6091' }, transcribe: { id: 'cartesia/ink-whisper' } }));
