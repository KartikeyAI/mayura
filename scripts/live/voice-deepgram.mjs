// Live check of @mayurajs/voice-deepgram: speech with Aura-2, then Nova-3 transcribes it. Run after pnpm build:
//   node --env-file=.env.live scripts/live/voice-deepgram.mjs  (needs DEEPGRAM_API_KEY)
import { report, voiceChecks } from './voice-checks.mjs';
const { deepgramVoice } = await import(new URL('../../extensions/voice-deepgram/dist/index.js', import.meta.url).href);

const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) { console.log('DEEPGRAM_API_KEY is not set; nothing run.'); process.exit(2); }
report(await voiceChecks({ providers: [deepgramVoice({ apiKey })], speak: { id: 'deepgram/aura-2', voice: 'thalia-en' }, transcribe: { id: 'deepgram/nova-3' } }));
