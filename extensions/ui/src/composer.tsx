'use client';

import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { attachmentContextDivider, maxPromptLength, maxQuoteLength } from './draft-context.js';
import { Icon } from './ui.js';
import { VoiceInput } from './voice.js';

const maxFiles = 3;
const maxFileBytes = 64 * 1024;
const maxExcerptChars = 240;
const fileTypes = '.txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json';
const followUps = ['Explain the trade-offs', 'What should we do next?'];

const toolbarButton = 'inline-grid size-8 shrink-0 place-items-center rounded-lg text-[color:var(--color-secondary)] '
  + 'enabled:cursor-pointer disabled:text-[color:var(--color-muted)] disabled:opacity-65 pointer-fine:enabled:hover:bg-[var(--color-wash)] '
  + 'transition-[background-color,color,transform] duration-[var(--motion-fast,140ms)] '
  + 'motion-safe:enabled:active:[transform:scale(.95)] motion-reduce:transition-none [@media(pointer:coarse)]:size-[2.625rem]';
const submitButton = 'composer-submit group/composer-submit ms-0.5 inline-grid size-8 shrink-0 place-items-center rounded-full bg-transparent text-white '
  + 'enabled:cursor-pointer motion-safe:enabled:active:[transform:scale(.95)] transition-transform duration-[var(--motion-fast,140ms)] '
  + 'ease-[var(--ease-out,ease-out)] motion-reduce:transition-none [@media(pointer:coarse)]:size-[2.625rem]';
const submitIcon = 'grid size-8 place-items-center rounded-full bg-[var(--color-action)] transition-colors duration-[var(--motion-fast,140ms)] '
  + 'pointer-fine:group-enabled/composer-submit:group-hover/composer-submit:bg-[var(--color-action-hover)] '
  + 'group-disabled/composer-submit:bg-[var(--color-wash)] group-disabled/composer-submit:text-[color:var(--color-muted)] motion-reduce:transition-none';

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

  return <form onSubmit={submit} data-dragging={dragging}
    className="rich-composer relative rounded-[1.125rem] border border-solid border-[color:var(--color-composer-line)] bg-[var(--color-paper)] p-2.5 sm:[.chat-body[data-empty=true]_&]:p-[0.8125rem] has-[.rich-composer-input:focus-visible]:outline-2 has-[.rich-composer-input:focus-visible]:outline-offset-2 has-[.rich-composer-input:focus-visible]:outline-[color:var(--color-line-strong)] [&_:focus-visible]:outline-[color:var(--color-ink)]"
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
    {dragging && <div role="status" className="composer-drop pointer-events-none absolute inset-1 z-[2] flex flex-col items-center justify-center gap-0.5 rounded-[0.875rem] border border-dashed border-[color:var(--color-line-strong)] bg-[var(--color-sidebar)] p-2 text-center text-[13px] text-[color:var(--color-secondary)] [&>svg]:mb-[3px]">
      <ToolbarIcon name="attach" />
      <strong>Drop files to add context</strong>
      <span className="text-[11px] text-[color:var(--color-muted)]">Text, Markdown, CSV, or JSON</span>
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
      {streaming && <div className="composer-voice-stop flex justify-end">
        <button type="button" className={submitButton} onClick={onStop} aria-label={command} title={command}>
          <span className={submitIcon}><Icon name="stop" size={16} /></span>
        </button>
      </div>}
    </div> : <>
      {quotedReply !== null && <div className="composer-quote mt-0.5 mb-1.5 flex items-start gap-2 rounded-[0.625rem] bg-[var(--color-wash)] px-2.5 py-2">
        <label className="min-w-0 flex-1 text-xs font-medium text-[color:var(--color-secondary)]">
          Quoted reply
          <textarea rows={2} value={quotedReply} maxLength={maxQuoteLength} disabled={disabled}
            onChange={event => onQuoteChange?.(event.target.value)}
            readOnly={!onQuoteChange}
            className="mt-1 block w-full resize-none rounded-sm bg-transparent text-xs font-normal leading-5 text-[color:var(--color-ink)]" />
        </label>
        {onQuoteChange && <button type="button" aria-label="Remove quoted reply" title="Remove quoted reply"
          className={'composer-icon-button ' + toolbarButton} onClick={() => { onQuoteChange(null); input.current?.focus(); }}>
          <Icon name="close" size={14} />
        </button>}
      </div>}
      {attachments.length > 0 && <ul aria-label="Draft context" className="composer-context mt-0.5 mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {attachments.map(file => <li key={file.id} title={file.label}
          className="composer-context-item inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--color-wash)] ps-2 text-xs text-[color:var(--color-secondary)]">
          <Icon name="file" size={13} />
          <span className="min-w-0 truncate">{file.label}</span>
          <button type="button" aria-label={'Remove ' + file.label}
            className="composer-remove inline-grid h-[1.625rem] w-6 shrink-0 cursor-pointer place-items-center rounded-lg text-[color:var(--color-secondary)] transition-colors duration-[var(--motion-fast,140ms)] pointer-fine:hover:bg-[var(--color-wash)] motion-reduce:transition-none [@media(pointer:coarse)]:size-9"
            onClick={() => {
              setAttachments(current => current.filter(item => item.id !== file.id));
              setNotice('');
              input.current?.focus();
            }}><Icon name="close" size={13} /></button>
        </li>)}
      </ul>}
      {recording && <div className="composer-recording mx-1.5 mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-[3px] text-xs font-[550] text-[color:var(--color-secondary)]">
        <span>Voice note <small className="ms-1.5 text-[11px] font-normal text-[color:var(--color-muted)]">Playback on this device</small></span>
        <audio className="row-start-2 w-full max-w-72" controls src={recording} preload="metadata" aria-label="Listen to your recorded voice note" />
        <button type="button" className={'composer-icon-button ' + toolbarButton} aria-label="Remove local recording" onClick={removeRecording}>
          <Icon name="close" size={15} />
        </button>
      </div>}
      <label htmlFor={fieldId} className="sr-only">Message</label>
      <textarea ref={input} id={fieldId} value={value} rows={2} maxLength={maxPromptLength} disabled={disabled}
        placeholder={streaming ? 'Draft a follow-up…' : 'Ask Mayura anything…'}
        aria-describedby={statusId} aria-invalid={overLimit || undefined}
        className="rich-composer-input block max-h-32 min-h-[2.875rem] w-full resize-none overflow-y-auto bg-transparent px-1.5 pt-1 pb-2 text-[15px] leading-normal text-[color:var(--color-ink)] [field-sizing:content] [scrollbar-color:var(--color-line-strong)_transparent] placeholder:text-[color:var(--color-muted)] focus-visible:outline-none sm:[.chat-body[data-empty=true]_&]:min-h-[3.625rem]"
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !streaming) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      {streaming && !value.trim() && <div className="composer-followups mx-1.5 mt-0.5 mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5" aria-label="Draft a follow-up">
        {followUps.map(text => <button type="button" key={text}
          className="min-h-7 cursor-pointer rounded-sm text-xs text-[color:var(--color-secondary)] pointer-fine:hover:text-[color:var(--color-ink)] pointer-fine:hover:underline pointer-fine:hover:underline-offset-[0.18em] [@media(pointer:coarse)]:min-h-9"
          onClick={() => {
          setValue(text);
          input.current?.focus();
        }}>{text}</button>)}
      </div>}
      <div className="composer-toolbar grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <button type="button" disabled={disabled || loadingFiles || attachments.length >= maxFiles}
          className="composer-attach composer-icon-button inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg ps-1.5 pe-2.5 text-xs font-[550] text-[color:var(--color-secondary)] transition-[background-color,color,transform] duration-[var(--motion-fast,140ms)] enabled:cursor-pointer disabled:text-[color:var(--color-muted)] disabled:opacity-65 pointer-fine:enabled:hover:bg-[var(--color-wash)] motion-safe:enabled:active:[transform:scale(.95)] motion-reduce:transition-none [@media(pointer:coarse)]:h-[2.625rem] [@media(pointer:coarse)]:px-2"
          title="Attach text files" aria-label="Attach text files" onClick={() => picker.current?.click()}>
          <ToolbarIcon name="attach" /><span>Attach</span>
        </button>
        <span className="composer-shortcut-hint hidden justify-self-end text-[11px] whitespace-nowrap text-[color:var(--color-muted)] [@media(min-width:36rem)_and_(hover:hover)_and_(pointer:fine)]:block" aria-hidden="true">{canSend ? 'Enter to send' : ''}</span>
        <div className="composer-actions flex items-center gap-0.5">
          <button type="button" className={'composer-icon-button ' + toolbarButton} title="Record a voice note" aria-label="Record a voice note"
            disabled={disabled} onClick={() => setVoiceMode('record')}><ToolbarIcon name="mic" /></button>
          <button type="button" className={'composer-icon-button ' + toolbarButton} title="Voice conversation" aria-label="Voice conversation"
            disabled={disabled} onClick={() => setVoiceMode('conversation')}><ToolbarIcon name="voice" /></button>
          <button type={streaming ? 'button' : 'submit'} className={submitButton} disabled={!streaming && !canSend}
            aria-label={command} title={command} onClick={streaming ? onStop : undefined}>
            <span className={submitIcon}><Icon name={streaming ? 'stop' : 'arrow'} size={16} /></span>
          </button>
        </div>
      </div>
    </>}
    <div id={statusId} role="status" className={overLimit || notice.startsWith('Attach')
      ? 'composer-note mx-1.5 mt-1.5 text-xs leading-[1.35] text-[color:var(--color-warning-ink)]' : 'sr-only'}>
      {overLimit ? 'Shorten your message or its context to send it.' : notice}
    </div>
  </form>;
}
