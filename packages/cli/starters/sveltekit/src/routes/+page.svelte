<script>
  import { onDestroy } from 'svelte';
  import { createNotebookView, display } from '../view.js';
  import '../style.css';
  const view = createNotebookView();
  let state = $state(view.getSnapshot()); let token = $state(''); let message = $state(''); let now = $state(Date.now());
  const unsubscribe = view.subscribe(() => { state = view.getSnapshot(); });
  let timer;
  // Clock reads only: decisions and network commands never run from an observer.
  import { onMount } from 'svelte';
  onMount(() => { timer = setInterval(() => { now = Date.now(); }, 1000); });
  onDestroy(() => { clearInterval(timer); unsubscribe(); view.dispose(); });
  const canSend = $derived(state.phase === 'ready' && !state.busy && !state.pending && !state.runId);
  const locked = $derived(state.busy || state.approval?.status !== 'idle' || (state.approval?.approval.expiresAtMs ?? 0) <= now);
  async function connect(event) { event.preventDefault(); const value = token; token = ''; await view.connect(value); }
  async function send(event) { event.preventDefault(); if (!canSend || !message.trim()) return; const value = message.trim(); await view.send(value); message = ''; }
</script>
<svelte:head><title>Mayura notebook</title><meta name="description" content="A persistent notebook with explicit approvals." /></svelte:head>
<main>
  <header><p class="eyebrow">MAYURA / NOTEBOOK</p><h1>Your words.<br />Your decision.</h1><p>Every note waits for your approval. No model key needed.</p></header>
  {#if !state.connected}
    <form onsubmit={connect}><label>Session token<input type="password" bind:value={token} maxlength="64" autocomplete="off" required /></label><button disabled={state.busy} type="submit">Connect</button></form>
  {:else}
    <button disabled={state.busy} onclick={() => view.disconnect()}>Disconnect</button>
    <nav aria-label="Conversations"><button disabled={!canSend} onclick={() => view.newThread()}>New conversation</button><button disabled={state.busy} onclick={() => view.list()}>Refresh list</button>
      {#each state.threads as thread (thread.id)}<button disabled={!canSend} onclick={() => view.select(thread.id)}>{thread.title || 'Untitled conversation'}</button>{/each}
      {#if state.cursor}<button disabled={state.busy} onclick={() => view.list(state.cursor)}>Next conversations</button>{/if}
    </nav>
    <section aria-label="Thread history"><h2>Conversation</h2><div role="log" aria-label="Saved messages">
      {#each state.history as entry (entry.sequence)}
        {#if entry.kind === 'user' || entry.kind === 'assistant'}<p><strong>{entry.kind === 'user' ? 'You' : 'Assistant'}</strong></p><pre>{display(entry.kind === 'user' ? entry.content : entry.output)}</pre>{/if}
      {/each}
    </div>
    {#if state.history.length}<button disabled={state.busy} onclick={() => view.history({ before: state.history[0].sequence })}>Earlier messages</button><button disabled={state.busy} onclick={() => view.history({ after: state.history[state.history.length - 1].sequence })}>Later messages</button>{/if}</section>
    {#if state.message}<p class="message">{state.message}</p>{/if}
    <p role="status">{state.runStatus || state.phase}</p>
    {#if state.approval && state.runStatus === 'waiting'}
      <aside aria-label="Review note"><h2>Review before saving</h2><p>{state.approval.approval.toolId}</p><pre>{display(state.approval.approval.input)}</pre>
        <p role="status">{locked ? 'Refresh if this approval has expired or changed.' : 'This exact note will be saved.'}</p>
        <button disabled={locked || JSON.stringify(state.approval.approval.input).length > 16000} onclick={() => view.decide('approved')}>Approve note</button><button disabled={locked} onclick={() => view.decide('rejected')}>Reject note</button>
      </aside>
    {/if}
    <nav aria-label="Run controls"><button disabled={state.busy} onclick={() => view.reconnect()}>Inspect / reconnect</button>{#if state.runId}<button disabled={state.busy} onclick={() => view.cancel()}>Cancel run</button>{/if}{#if state.pending}<button disabled={state.busy} onclick={() => view.retry()}>Retry exact submission</button>{/if}</nav>
    <form onsubmit={send}><label>Message<textarea bind:value={message} maxlength="2000" disabled={!canSend}></textarea></label><button disabled={!canSend || !message.trim()} type="submit">Send message</button></form>
  {/if}
  {#if state.error}<p role="alert">{state.error}</p>{/if}
  <footer>Notes and approvals use your configured database. Re-enter your token after reload to restore this tab's selection.</footer>
</main>
