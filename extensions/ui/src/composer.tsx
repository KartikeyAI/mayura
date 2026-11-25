import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { attachmentContextDivider, maxPromptLength, maxQuoteLength } from './draft-context.js';
import { Icon } from './ui.js';
import { VoiceInput } from './voice.js';

const maxFiles = 3;
const maxFileBytes = 64 * 1024;
const maxExcerptChars = 240;
const fileTypes = '.txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json';
const followUps = ['Explain the trade-offs', 'What should we do next?'];

interface Attachment {
  readonly id: string;
  readonly label: string;
  readonly excerpt: string;
}

function ToolbarIcon({ name }: { name: 'attach' | 'mic' | 'voice' }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
    {name === 'attach' && <path d="M8.4 13.8 14.1 8a2.4 2.4 0 1 1 3.4 3.4l-7.1 7.2a4 4 0 0 1-5.7-5.7l7.4-7.4" />}
    {name === 'mic' && <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-3 0h6" /></>}
    {name === 'voice' && <path d="M3 10v4m4-7v10m5-13v16m5-13v10m4-7v4" />}
  </svg>;
}

export interface ComposerProps {
  onSend(text: string): boolean;
  onStop(): void;
  readonly streaming: boolean;
  readonly disabled: boolean;
  readonly assistantReply?: { id: string; content: string } | null | undefined;
  readonly quotedReply?: string | null;
  onQuoteChange?(quote: string | null): void;
}

export function Composer({ onSend, onStop, streaming, disabled, assistantReply, quotedReply = null, onQuoteChange }: ComposerProps) {
  const fieldId = useId();
  const statusId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const voicePanel = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const reading = useRef(false);
  const recordingUrl = useRef<string | null>(null);
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<'record' | 'conversation' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => () => {
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
  }, []);
  useEffect(() => {
    if (disabled) setVoiceMode(null);
    else if (voiceMode) voicePanel.current?.focus({ preventScroll: true });
  }, [disabled, voiceMode]);

  const contextItems = attachments.map(file => file.label + '\n' + file.excerpt);
  if (quotedReply?.trim()) contextItems.unshift('Quoted reply\n' + quotedReply.trim());
  const context = contextItems.length ? attachmentContextDivider + contextItems.join('\n\n') : '';
  const overLimit = value.trim().length + context.length > maxPromptLength;
  const canSend = !disabled && !streaming && !loadingFiles && !overLimit && Boolean(value.trim());
  const command = streaming ? 'Stop response' : 'Send message';

  function sendText(text: string): boolean {
    const trimmed = text.trim();
    if (disabled || streaming || reading.current || !trimmed) return false;
    if (trimmed.length + context.length > maxPromptLength) {
      setNotice('Shorten your message or its context to send it.');
      return false;
    }
    if (!onSend(trimmed + context)) return false;
    setValue('');
    setAttachments([]);
    onQuoteChange?.(null);
    setNotice('');
    return true;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSend) sendText(value);
  }

  async function addFiles(files: FileList) {
    if (disabled || reading.current || !files.length) return;
    const incoming = Array.from(files);
    reading.current = true;
    setLoadingFiles(true);
    setNotice('');
    const added: Attachment[] = [];
    const ids = new Set(attachments.map(file => file.id));
    let skipped = false;
    try {
      for (const file of incoming) {
        if (ids.size >= maxFiles) { skipped = true; break; }
        const allowedType = /\.(txt|md|csv|json)$/iu.test(file.name)
          || /^(text\/(plain|markdown|csv)|application\/json)$/iu.test(file.type);
        if (!allowedType || !file.size || file.size > maxFileBytes) { skipped = true; continue; }
        const label = file.name.replace(/[\r\n\t]/gu, ' ').slice(0, 80) || 'Untitled file';
        const id = JSON.stringify([file.name, file.size, file.lastModified]);
        if (ids.has(id)) continue;
        try {
          const content = (await file.text()).trim();
          if (!content || content.includes('\0')) { skipped = true; continue; }
          const excerpt = content.length > maxExcerptChars ? content.slice(0, maxExcerptChars - 1) + '…' : content;
          added.push({ id, label, excerpt });
          ids.add(id);
        } catch { skipped = true; }
      }
      setAttachments(current => [...current, ...added]);
      if (skipped) setNotice('Attach up to three text, Markdown, CSV, or JSON files under 64 KB each.');
      else if (added.length) setNotice(added.length === 1 ? 'One context file added.' : added.length + ' context files added.');
    } finally {
      reading.current = false;
      setLoadingFiles(false);
    }
  }

  function dragEnter(event: DragEvent<HTMLFormElement>) {
    if (disabled || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.files.length && !dragDepth.current) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  }

  function removeRecording() {
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
    recordingUrl.current = null;
    setRecording(null);
  }

  function closeVoice() {
    setVoiceMode(null);
    requestAnimationFrame(() => input.current?.focus());
  }

  function storeRecording(blob: Blob) {
    removeRecording();
    const url = URL.createObjectURL(blob);
    recordingUrl.current = url;
    setRecording(url);
  }

  return <form onSubmit={submit} className="rich-composer" data-dragging={dragging}
    onDragEnter={dragEnter}
    onDragLeave={() => {
      if (dragDepth.current > 0) dragDepth.current--;
      if (!dragDepth.current) setDragging(false);
    }}
    onDragOver={event => {
      if (!disabled && event.dataTransfer.types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    }}
    onDrop={drop}>
    {dragging && <div className="composer-drop" role="status">
      <ToolbarIcon name="attach" />
      <strong>Drop files to add context</strong>
      <span>Text, Markdown, CSV, or JSON</span>
    </div>}

    <input ref={picker} type="file" accept={fileTypes} multiple hidden aria-label="Choose context files"
      onChange={event => {
        if (event.target.files) void addFiles(event.target.files);
        event.target.value = '';
      }} />

    {voiceMode && !disabled ? <div ref={voicePanel} tabIndex={-1} role="group" aria-label={voiceMode === 'record' ? 'Voice note' : 'Voice conversation'}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeVoice(); }
      }}>
      <VoiceInput mode={voiceMode} onClose={closeVoice} onRecord={storeRecording}
        onTranscript={sendText} busy={streaming || disabled} assistantReply={assistantReply} />
      {streaming && <div className="composer-voice-stop">
        <button type="button" className="composer-submit" onClick={onStop} aria-label={command} title={command}>
          <span><Icon name="stop" size={16} /></span>
        </button>
      </div>}
    </div> : <>
      {quotedReply !== null && <div className="composer-quote">
        <label className="min-w-0 flex-1 text-xs font-medium text-secondary">
          Quoted reply
          <textarea rows={2} value={quotedReply} maxLength={maxQuoteLength} disabled={disabled}
            onChange={event => onQuoteChange?.(event.target.value)}
            readOnly={!onQuoteChange}
            className="mt-1 block w-full resize-none rounded-sm bg-transparent text-xs font-normal leading-5 text-ink" />
        </label>
        {onQuoteChange && <button type="button" aria-label="Remove quoted reply" title="Remove quoted reply"
          className="composer-icon-button" onClick={() => { onQuoteChange(null); input.current?.focus(); }}>
          <Icon name="close" size={14} />
        </button>}
      </div>}
      {attachments.length > 0 && <ul aria-label="Draft context" className="composer-context">
        {attachments.map(file => <li key={file.id} title={file.label} className="composer-context-item">
          <Icon name="file" size={13} />
          <span>{file.label}</span>
          <button type="button" aria-label={'Remove ' + file.label} className="composer-remove"
            onClick={() => {
              setAttachments(current => current.filter(item => item.id !== file.id));
              setNotice('');
              input.current?.focus();
            }}><Icon name="close" size={13} /></button>
        </li>)}
      </ul>}
      {recording && <div className="composer-recording">
        <span>Voice note <small>Playback on this device</small></span>
        <audio controls src={recording} preload="metadata" aria-label="Listen to your recorded voice note" />
        <button type="button" className="composer-icon-button" aria-label="Remove local recording" onClick={removeRecording}>
          <Icon name="close" size={15} />
        </button>
      </div>}
      <label htmlFor={fieldId} className="sr-only">Message</label>
      <textarea ref={input} id={fieldId} value={value} rows={2} maxLength={maxPromptLength} disabled={disabled}
        placeholder={streaming ? 'Draft a follow-up…' : 'Ask Mayura anything…'}
        aria-describedby={statusId} aria-invalid={overLimit || undefined}
        className="rich-composer-input"
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !streaming) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      {streaming && !value.trim() && <div className="composer-followups" aria-label="Draft a follow-up">
        {followUps.map(text => <button type="button" key={text} onClick={() => {
          setValue(text);
          input.current?.focus();
        }}>{text}</button>)}
      </div>}
      <div className="composer-toolbar">
        <button type="button" className="composer-attach composer-icon-button" disabled={disabled || loadingFiles || attachments.length >= maxFiles}
          title="Attach text files" aria-label="Attach text files" onClick={() => picker.current?.click()}>
          <ToolbarIcon name="attach" /><span>Attach</span>
        </button>
        <span className="composer-shortcut-hint" aria-hidden="true">{canSend ? 'Enter to send' : ''}</span>
        <div className="composer-actions">
          <button type="button" className="composer-icon-button" title="Record a voice note" aria-label="Record a voice note"
            disabled={disabled} onClick={() => setVoiceMode('record')}><ToolbarIcon name="mic" /></button>
          <button type="button" className="composer-icon-button" title="Voice conversation" aria-label="Voice conversation"
            disabled={disabled} onClick={() => setVoiceMode('conversation')}><ToolbarIcon name="voice" /></button>
          <button type={streaming ? 'button' : 'submit'} className="composer-submit" disabled={!streaming && !canSend}
            aria-label={command} title={command} onClick={streaming ? onStop : undefined}>
            <span><Icon name={streaming ? 'stop' : 'arrow'} size={16} /></span>
          </button>
        </div>
      </div>
    </>}
    <div id={statusId} role="status" className={overLimit || notice.startsWith('Attach') ? 'composer-note' : 'sr-only'}>
      {overLimit ? 'Shorten your message or its context to send it.' : notice}
    </div>
  </form>;
}
