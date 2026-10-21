<script setup>
import { computed, onBeforeUnmount, onMounted, shallowRef, ref } from 'vue';
import { createNotebookView, display } from '../src/view.js';
const view = createNotebookView(); const state = shallowRef(view.getSnapshot()); const token = ref(''); const message = ref(''); const now = ref(Date.now()); let timer;
const unsubscribe = view.subscribe(() => { state.value = view.getSnapshot(); });
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { clearInterval(timer); unsubscribe(); view.dispose(); });
const canSend = computed(() => state.value.phase === 'ready' && !state.value.busy && !state.value.pending && !state.value.runId);
const locked = computed(() => state.value.busy || state.value.approval?.status !== 'idle' || (state.value.approval?.approval.expiresAtMs ?? 0) <= now.value);
async function connect() { const value = token.value; token.value = ''; await view.connect(value); }
async function send() { if (!canSend.value || !message.value.trim()) return; const value = message.value.trim(); await view.send(value); message.value = ''; }
</script>
<template>
  <main>
    <header><p class="eyebrow">MAYURA / NOTEBOOK</p><h1>Your words.<br />Your decision.</h1><p>Every note waits for your approval. No model key needed.</p></header>
    <form v-if="!state.connected" @submit.prevent="connect"><label>Session token<input v-model="token" type="password" maxlength="64" autocomplete="off" required /></label><button :disabled="state.busy" type="submit">Connect</button></form>
    <template v-else>
      <button :disabled="state.busy" @click="view.disconnect()">Disconnect</button>
      <nav aria-label="Conversations"><button :disabled="!canSend" @click="view.newThread()">New conversation</button><button :disabled="state.busy" @click="view.list()">Refresh list</button>
        <button v-for="thread in state.threads" :key="thread.id" :disabled="!canSend" @click="view.select(thread.id)">{{ thread.title || 'Untitled conversation' }}</button><button v-if="state.cursor" :disabled="state.busy" @click="view.list(state.cursor)">Next conversations</button>
      </nav>
      <section aria-label="Thread history"><h2>Conversation</h2><div role="log" aria-label="Saved messages">
        <template v-for="entry in state.history" :key="entry.sequence"><template v-if="entry.kind === 'user' || entry.kind === 'assistant'"><p><strong>{{ entry.kind === 'user' ? 'You' : 'Assistant' }}</strong></p><pre>{{ display(entry.kind === 'user' ? entry.content : entry.output) }}</pre></template></template>
      </div><template v-if="state.history.length"><button :disabled="state.busy" @click="view.history({ before: state.history[0].sequence })">Earlier messages</button><button :disabled="state.busy" @click="view.history({ after: state.history[state.history.length - 1].sequence })">Later messages</button></template></section>
      <p v-if="state.message" class="message">{{ state.message }}</p><p role="status">{{ state.runStatus || state.phase }}</p>
      <aside v-if="state.approval && state.runStatus === 'waiting'" aria-label="Review note"><h2>Review before saving</h2><p>{{ state.approval.approval.toolId }}</p><pre>{{ display(state.approval.approval.input) }}</pre>
        <p role="status">{{ locked ? 'Refresh if this approval has expired or changed.' : 'This exact note will be saved.' }}</p><button :disabled="locked || JSON.stringify(state.approval.approval.input).length > 16000" @click="view.decide('approved')">Approve note</button><button :disabled="locked" @click="view.decide('rejected')">Reject note</button>
      </aside>
      <nav aria-label="Run controls"><button :disabled="state.busy" @click="view.reconnect()">Inspect / reconnect</button><button v-if="state.runId" :disabled="state.busy" @click="view.cancel()">Cancel run</button><button v-if="state.pending" :disabled="state.busy" @click="view.retry()">Retry exact submission</button></nav>
      <form @submit.prevent="send"><label>Message<textarea v-model="message" maxlength="2000" :disabled="!canSend"></textarea></label><button :disabled="!canSend || !message.trim()" type="submit">Send message</button></form>
    </template>
    <p v-if="state.error" role="alert">{{ state.error }}</p><footer>Notes and approvals use your configured database. Re-enter your token after reload to restore this tab's selection.</footer>
  </main>
</template>
