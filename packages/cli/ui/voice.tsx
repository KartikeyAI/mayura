import { useEffect, useRef, useState } from 'react';
import './ui.css';
/** Explicit microphone access per click; every track is stopped, with a hard recording bound. Host owns transcription. */
export function Voice({ onRecording }: { readonly onRecording: (recording: Blob) => Promise<void> }) {
  const [active, setActive] = useState(false); const [error, setError] = useState(''); const recorder = useRef<MediaRecorder | null>(null); const busy = useRef(false); const mounted = useRef(false); const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timeout.current); const current = recorder.current;
    if (current) { current.onstop = () => { current.stream.getTracks().forEach(track => track.stop()); }; if (current.state !== 'inactive') current.stop(); current.stream.getTracks().forEach(track => track.stop()); } }; }, []);
  async function start() { if (busy.current) return; busy.current = true; setError('');
    let stream: MediaStream | undefined;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); if (!mounted.current) { stream.getTracks().forEach(track => track.stop()); busy.current=false; return; } const media = new MediaRecorder(stream); recorder.current = media; const chunks: Blob[] = []; let size = 0;
      const timer = timeout.current = setTimeout(() => { if (media.state !== 'inactive') media.stop(); },30000);
      media.ondataavailable = event => { size += event.data.size; if (size <= 4000000) chunks.push(event.data); else if (media.state !== 'inactive') media.stop(); };
      media.onstop = () => { clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); recorder.current = null; if (!mounted.current) { busy.current=false; return; } setActive(false);
        if (size === 0 || size > 4000000) { busy.current = false; setError('Recording exceeded the size limit.'); return; }
        void onRecording(new Blob(chunks,{ type: media.mimeType })).catch(() => setError('Recording delivery was not confirmed.')).finally(() => { busy.current = false; }); };
      media.onerror = () => { setError('Microphone recording failed.'); if (media.state !== 'inactive') media.stop(); };
      media.start(250); setActive(true);
    } catch { stream?.getTracks().forEach(track => track.stop()); busy.current = false; setError('Microphone access is unavailable.'); }
  }
  return <section className="mayura-ui"><button type="button" aria-pressed={active} onClick={() => { if (active) recorder.current?.stop(); else void start(); }}>{active ? 'Stop recording' : 'Record a voice message'}</button><small>Up to 30 seconds. Sent only to your configured handler.</small>{error ? <p role="alert">{error}</p> : null}</section>;
}
