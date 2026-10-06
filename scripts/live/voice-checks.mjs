// Shared by the voice-*.mjs live checks: speak a sentence, then transcribe audio and find its words, through
// mayura/voice with the providers' catalog prices. Prints sizes, costs and outcomes only; never a key.
const { createVoices } = await import(new URL('../../packages/mayura/dist/voice.js', import.meta.url).href);

export const sentence = 'The quick brown fox jumps over the lazy dog.';

/**
 * `speak`: { id, voice } of a speech model; `transcribe`: { id } of a transcription model. Transcription uses the
 * spoken audio, or `audioFrom` ({ provider, id, voice }) when the provider only transcribes. Returns [name, outcome].
 */
export async function voiceChecks({ providers, speak, transcribe, audioFrom, maxCallCostMicros = 50_000 }) {
  const voices = createVoices({ providers, prices: 'catalog', maxCallCostMicros });
  const results = [];
  const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.code ?? ''} ${error.message}`]); } };
  let audio;
  const speakWith = async ({ id, voice }) => {
    const speech = await voices.speaker(id).speak({ text: sentence, voice });
    const bytes = speech.audio?.data?.byteLength ?? 0;
    console.log(`  ${id}: ${bytes} bytes of ${speech.audio?.mediaType ?? 'audio'}, ${speech.usage?.costMicros ?? '?'} micros`);
    if (bytes < 1_000) throw new Error(`only ${bytes} bytes of audio`);
    return speech.audio;
  };
  if (speak) await check(`speaks with ${speak.id}`, async () => { audio = await speakWith(speak); });
  else if (audioFrom) {
    try { audio = await speakWith(audioFrom); } catch (error) { results.push([`makes audio to transcribe with ${audioFrom.id}`, `FAILED: ${error.message}`]); }
  }
  if (transcribe) {
    await check(`transcribes with ${transcribe.id}`, async () => {
      if (!audio) throw new Error('no audio to transcribe');
      // Compressed audio needs a duration; ten seconds bounds the cost of a sentence well above what it takes.
      const transcript = await voices.transcriber(transcribe.id).transcribe({ audio, durationMs: 10_000 });
      console.log(`  ${transcribe.id}: ${transcript.text?.length ?? 0} characters, ${transcript.usage?.costMicros ?? '?'} micros`);
      if (!/fox/i.test(transcript.text ?? '') || !/dog/i.test(transcript.text ?? '')) throw new Error('the transcript does not have the sentence\'s words');
    });
  }
  return results;
}

export function report(results) {
  for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
  process.exitCode = results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0;
}
