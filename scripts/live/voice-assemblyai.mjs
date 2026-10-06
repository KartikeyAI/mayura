// Live check of @mayurajs/voice-assemblyai: Universal transcribes a spoken sentence. AssemblyAI only transcribes, so
// the sentence is spoken by Deepgram or ElevenLabs first. Run after pnpm build:
//   node --env-file=.env.live scripts/live/voice-assemblyai.mjs  (needs ASSEMBLYAI_API_KEY, and DEEPGRAM_API_KEY or ELEVENLABS_API_KEY)
import { report, voiceChecks } from './voice-checks.mjs';
const root = new URL('../../', import.meta.url);
const { assemblyaiVoice } = await import(new URL('extensions/voice-assemblyai/dist/index.js', root).href);

const { ASSEMBLYAI_API_KEY: apiKey, DEEPGRAM_API_KEY: deepgramKey, ELEVENLABS_API_KEY: elevenlabsKey } = process.env;
if (!apiKey || !(deepgramKey || elevenlabsKey)) { console.log('ASSEMBLYAI_API_KEY, and DEEPGRAM_API_KEY or ELEVENLABS_API_KEY, are not set; nothing run.'); process.exit(2); }
const speaker = deepgramKey
  ? { provider: (await import(new URL('extensions/voice-deepgram/dist/index.js', root).href)).deepgramVoice({ apiKey: deepgramKey }), id: 'deepgram/aura-2', voice: 'thalia-en' }
  : { provider: (await import(new URL('extensions/voice-elevenlabs/dist/index.js', root).href)).elevenlabsVoice({ apiKey: elevenlabsKey }), id: 'elevenlabs/eleven_v3', voice: 'JBFqnCBsd6RMkjVDRZzb' };
report(await voiceChecks({ providers: [assemblyaiVoice({ apiKey }), speaker.provider], audioFrom: { id: speaker.id, voice: speaker.voice }, transcribe: { id: 'assemblyai/universal-3-5-pro' } }));
