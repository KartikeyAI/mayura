import { useCallback, useEffect, useRef, useState } from 'react';
import { maxPromptLength } from './draft-context.js';
import { Icon } from './ui.js';

export interface VoiceInputProps {
  readonly mode: 'record' | 'conversation';
  onClose(): void;
  onRecord(blob: Blob): void;
  onTranscript(text: string): boolean;
  readonly busy?: boolean;
  readonly assistantReply?: { readonly id: string; readonly content: string } | null | undefined;
}

const maxRecordingMs = 30_000;
const maxRecordingBytes = 4 * 1024 * 1024;
const maxHoldingMs = 120_000;
const language = 'en-US';
const voiceCapture = () => typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined'
  && typeof navigator.mediaDevices?.getUserMedia === 'function';

interface Capture {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  ticker?: number;
  deadline?: number;
  flushTimer?: number;
  chunks: Blob[];
  bytes: number;
  elapsed: number;
  started?: number;
  keep: boolean;
}

function releaseCapture(capture: Capture): void {
  window.clearInterval(capture.ticker);
  window.clearTimeout(capture.deadline);
  window.clearTimeout(capture.flushTimer);
  if (capture.recorder?.state && capture.recorder.state !== 'inactive') capture.recorder.stop();
  capture.stream?.getTracks().forEach(track => track.stop());
}

function timeLabel(ms: number): string {
  const seconds = Math.floor(Math.min(ms, maxRecordingMs) / 1000);
  return '0:' + String(seconds).padStart(2, '0');
}

function VoiceNote({ onClose, onRecord }: Pick<VoiceInputProps, 'onClose' | 'onRecord'>) {
  const captureRef = useRef<Capture | null>(null);
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'paused' | 'processing' | 'preview'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const previewRef = useRef<{ readonly blob: Blob; readonly url: string } | null>(null);

  useEffect(() => {
    setAvailable(voiceCapture());
    return () => {
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) releaseCapture(capture);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    };
  }, []);

  function fail(capture: Capture, message: string) {
    if (captureRef.current !== capture) return;
    captureRef.current = null;
    releaseCapture(capture);
    setPhase('idle');
    setElapsed(0);
    setError(message);
  }

  function finish(capture: Capture) {
    if (captureRef.current !== capture || !capture.recorder || capture.recorder.state === 'inactive') return;
    if (capture.started !== undefined) capture.elapsed += performance.now() - capture.started;
    delete capture.started;
    setElapsed(capture.elapsed);
    capture.keep = true;
    window.clearInterval(capture.ticker);
    window.clearTimeout(capture.deadline);
    setPhase('processing');
    capture.recorder.stop();
    capture.flushTimer = window.setTimeout(() => fail(capture, 'The browser could not prepare this recording.'), 2_000);
  }

  async function start() {
    if (captureRef.current || !voiceCapture()) return;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    previewRef.current = null;
    setError('');
    setElapsed(0);
    setPhase('requesting');
    const capture: Capture = { chunks: [], bytes: 0, elapsed: 0, keep: false };
    captureRef.current = capture;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (captureRef.current !== capture) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      capture.stream = stream;
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 64_000 });
      capture.recorder = recorder;
      recorder.addEventListener('dataavailable', event => {
        if (captureRef.current !== capture || !event.data.size) return;
        capture.bytes += event.data.size;
        if (capture.bytes > maxRecordingBytes) {
          fail(capture, 'The recording exceeded the 4 MB limit.');
          return;
        }
        capture.chunks.push(event.data);
      });
      recorder.addEventListener('error', () => fail(capture, 'The microphone recording was interrupted.'));
      recorder.addEventListener('stop', () => {
        if (captureRef.current !== capture) return;
        if (!capture.keep || !capture.chunks.length) {
          fail(capture, 'No audio was captured. Try a new recording.');
          return;
        }
        const blob = new Blob(capture.chunks, { type: recorder.mimeType || capture.chunks[0]?.type || '' });
        captureRef.current = null;
        releaseCapture(capture);
        previewRef.current = { blob, url: URL.createObjectURL(blob) };
        setPhase('preview');
      });
      recorder.start(250);
      capture.started = performance.now();
      capture.deadline = window.setTimeout(() => finish(capture), maxHoldingMs);
      capture.ticker = window.setInterval(() => {
        if (captureRef.current !== capture || capture.started === undefined) return;
        const ms = capture.elapsed + performance.now() - capture.started;
        if (ms >= maxRecordingMs) finish(capture);
        else setElapsed(ms);
      }, 125);
      setPhase('recording');
    } catch (reason) {
      fail(capture, reason instanceof DOMException && reason.name === 'NotAllowedError'
        ? 'Microphone access was denied. You can use the text composer instead.'
        : 'The browser could not open the microphone.');
    }
  }

  function togglePause() {
    const capture = captureRef.current;
    const recorder = capture?.recorder;
    if (!capture || !recorder) return;
    if (recorder.state === 'recording') {
      if (capture.started !== undefined) capture.elapsed += performance.now() - capture.started;
      delete capture.started;
      recorder.pause();
      setElapsed(capture.elapsed);
      setPhase('paused');
    } else if (recorder.state === 'paused') {
      recorder.resume();
      capture.started = performance.now();
      setPhase('recording');
    }
  }

  function attach() {
    const clip = previewRef.current;
    if (!clip) return;
    onRecord(clip.blob);
    discard();
  }

  function discard() {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) releaseCapture(capture);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    previewRef.current = null;
    onClose();
  }

  const phaseText = {
    idle: 'Record up to 30 seconds on this device.',
    requesting: 'Waiting for microphone access…',
    recording: 'Recording',
    paused: 'Recording paused',
    processing: 'Preparing the recording…',
    preview: 'Review your voice note',
  }[phase];
  const showTimer = phase === 'recording' || phase === 'paused';

  return <section className="voice-panel" aria-label="Voice note">
    <div className="voice-main">
      <div className="voice-status">
        {showTimer && <span className="voice-dot" data-recording={phase === 'recording'} aria-hidden="true" />}
        <span role="status">{available ? phaseText : 'Audio recording is unavailable in this browser.'}</span>
        {showTimer && <span className="voice-clock" aria-label="Elapsed time">{timeLabel(elapsed)}</span>}
      </div>
      <div className="voice-actions">
        <button type="button" className="voice-action" onClick={discard}>{phase === 'idle' ? 'Cancel' : 'Discard'}</button>
        {phase === 'idle' && available && <button type="button" className="voice-action voice-primary" onClick={() => void start()}>Record</button>}
        {showTimer && <>
          <button type="button" className="voice-action" onClick={togglePause}>{phase === 'paused' ? 'Resume' : 'Pause'}</button>
          <button type="button" className="voice-action voice-primary" onClick={() => {
            if (captureRef.current) finish(captureRef.current);
          }}>Review</button>
        </>}
        {phase === 'preview' && <button type="button" className="voice-action voice-primary" onClick={attach}><Icon name="check" size={14} /> Add note</button>}
      </div>
    </div>
    {phase === 'preview' && previewRef.current && <audio className="voice-preview" aria-label="Play voice note" controls preload="metadata" src={previewRef.current.url} />}
    {error && <p role="alert" className="voice-message">{error}</p>}
  </section>;
}

interface LocalRecognition extends EventTarget {
  processLocally: boolean;
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
}

type PackStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';
type RecognitionType = {
  new (): LocalRecognition;
  available?(options: { langs: string[]; processLocally: true }): Promise<PackStatus>;
};

type ResultEvent = Event & {
  readonly resultIndex: number;
  readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0?: { readonly transcript: string } }>;
};

function recognizer(): RecognitionType | undefined {
  const browser = window as Window & { SpeechRecognition?: RecognitionType; webkitSpeechRecognition?: RecognitionType };
  const candidates = [browser.SpeechRecognition, browser.webkitSpeechRecognition];
  return candidates.find(candidate => typeof candidate?.available === 'function' && 'processLocally' in candidate.prototype);
}

function localVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices().filter(voice => voice.localService);
  return voices?.find(voice => voice.lang.toLowerCase() === 'en-us')
    ?? voices?.find(voice => voice.lang.toLowerCase().startsWith('en'));
}

function SpeechConversation({ onClose, onTranscript, busy, assistantReply }: Omit<VoiceInputProps, 'mode' | 'onRecord'>) {
  const [availability, setAvailability] = useState<'checking' | PackStatus>('checking');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [message, setMessage] = useState('');
  const [voice, setVoice] = useState<SpeechSynthesisVoice>();
  const recognition = useRef<{ owner: LocalRecognition; deadline?: number } | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const waiting = useRef<{ previousId: string | undefined; observedBusy: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => setVoice(localVoice());
    const synthesis = window.speechSynthesis;
    refresh();
    synthesis?.addEventListener('voiceschanged', refresh);
    const browser = recognizer();
    if (!browser?.available) setAvailability('unavailable');
    else void browser.available({ langs: [language], processLocally: true }).then(
      status => { if (alive) setAvailability(status); },
      () => { if (alive) setAvailability('unavailable'); },
    );
    return () => {
      alive = false;
      synthesis?.removeEventListener('voiceschanged', refresh);
      const current = recognition.current;
      recognition.current = null;
      if (current) {
        window.clearTimeout(current.deadline);
        current.owner.abort();
      }
      if (utterance.current) {
        utterance.current = null;
        synthesis?.cancel();
      }
    };
  }, []);

  function stopSpeech() {
    if (!utterance.current) return;
    utterance.current = null;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  const speak = useCallback((text: string) => {
    if (!voice || !window.speechSynthesis || utterance.current) return;
    const answer = new SpeechSynthesisUtterance(text.replace(/\[\d{1,2}\]|\*\*/gu, '').slice(0, 1_800));
    if (!answer.text.trim()) return;
    answer.voice = voice;
    answer.lang = voice.lang;
    utterance.current = answer;
    setSpeaking(true);
    const complete = () => {
      if (utterance.current !== answer) return;
      utterance.current = null;
      setSpeaking(false);
    };
    answer.onend = complete;
    const failed = () => {
      if (utterance.current !== answer) return;
      complete();
      setMessage('Playback did not start. You can play the reply again.');
    };
    answer.onerror = failed;
    try { window.speechSynthesis.speak(answer); } catch { failed(); }
  }, [voice]);

  useEffect(() => {
    const pending = waiting.current;
    if (!pending || listening) return;
    if (busy) {
      pending.observedBusy = true;
      return;
    }
    if (assistantReply && assistantReply.id !== pending.previousId) {
      waiting.current = null;
      speak(assistantReply.content);
    } else if (pending.observedBusy) waiting.current = null;
  }, [assistantReply, busy, listening, speak]);

  function stopListening() {
    const session = recognition.current;
    if (!session) return;
    recognition.current = null;
    window.clearTimeout(session.deadline);
    session.owner.abort();
    setListening(false);
  }

  function listen() {
    const BrowserRecognition = recognizer();
    if (!BrowserRecognition || availability !== 'available' || !voice || busy || recognition.current) return;
    stopSpeech();
    setMessage('');
    const owner = new BrowserRecognition();
    // Require on-device processing even if the browser also offers a cloud service.
    owner.processLocally = true;
    owner.lang = language;
    owner.interimResults = false;
    owner.continuous = false;
    owner.maxAlternatives = 1;
    const session: { owner: LocalRecognition; deadline?: number } = { owner };
    recognition.current = session;
    let heard = false;
    let failed = false;
    owner.addEventListener('result', event => {
      if (recognition.current !== session || heard) return;
      const { results, resultIndex } = event as ResultEvent;
      const result = results[resultIndex];
      const spoken = result?.isFinal ? result[0]?.transcript.trim() : '';
      if (!spoken) return;
      heard = true;
      waiting.current = { previousId: assistantReply?.id, observedBusy: false };
      if (spoken.length > maxPromptLength || !onTranscript(spoken)) {
        waiting.current = null;
        setMessage('The voice prompt could not be sent. Try a shorter prompt or use the composer.');
      }
    });
    owner.addEventListener('error', () => {
      if (recognition.current !== session) return;
      failed = true;
      setMessage('On-device recognition could not listen. Check microphone access or type your prompt.');
    });
    owner.addEventListener('end', () => {
      if (recognition.current !== session) return;
      recognition.current = null;
      window.clearTimeout(session.deadline);
      setListening(false);
      if (!heard && !failed) setMessage('No speech was recognized. Try again when you’re ready.');
    });
    try {
      owner.start();
      setListening(true);
      session.deadline = window.setTimeout(() => {
        stopListening();
        setMessage('Listening ended. Try again when you’re ready.');
      }, 20_000);
    } catch {
      stopListening();
      setMessage('On-device recognition could not start. You can still type or record a note.');
    }
  }

  const status = listening ? 'Listening on this device…' : speaking ? 'Reading the reply…' : busy ? 'Waiting for Mayura…'
    : availability === 'checking' ? 'Checking on-device speech…'
    : availability === 'downloadable' || availability === 'downloading' ? 'Install the English (US) speech pack in your browser to talk.'
    : availability === 'unavailable' ? 'On-device speech recognition is unavailable. You can still type or record a note.'
    : !voice ? 'No local English voice is available. You can still type or record a note.'
    : 'Speak in English (US). Mayura’s reply will play aloud.';

  return <section className="voice-panel" aria-label="Voice conversation">
    <div className="voice-main">
      <div className="voice-status">
        {listening && <span className="voice-dot" data-recording="true" aria-hidden="true" />}
        <span role="status">{status}</span>
      </div>
      <div className="voice-actions">
        <button type="button" className="voice-action" onClick={onClose}>Close</button>
        {speaking && <button type="button" className="voice-action" onClick={stopSpeech}>Mute reply</button>}
        {!speaking && !listening && !busy && assistantReply && voice &&
          <button type="button" className="voice-action" onClick={() => { setMessage(''); speak(assistantReply.content); }}>Play reply</button>}
        {listening ? <button type="button" className="voice-action voice-primary" onClick={stopListening}>Stop listening</button> :
          availability === 'available' && voice && <button type="button" className="voice-action voice-primary" disabled={busy} onClick={listen}>Talk</button>}
      </div>
    </div>
    {message && <p role="status" className="voice-message">{message}</p>}
  </section>;
}

/** Browser audio controls. Recording stays local and recognition never falls back to a remote service. */
export function VoiceInput(props: VoiceInputProps) {
  return props.mode === 'record' ? <VoiceNote onClose={props.onClose} onRecord={props.onRecord} /> : <SpeechConversation {...props} />;
}
