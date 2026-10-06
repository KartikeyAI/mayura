// Shared by the observability-*.mjs live checks: one agent run's spans (a model call with token counts and a tool
// call) sent through a provider's trace exporter. Prints the exporter's counters and HTTP statuses only; never a key or
// a reply body.
const { agentRunTraceSpans } = await import(new URL('../../packages/mayura/dist/exporter-otlp.js', import.meta.url).href);

/** The spans of a short, successful run, timed a few seconds ago. */
export function runSpans() {
  const now = Date.now(); const at = offset => new Date(now - 8_000 + offset * 1_000).toISOString();
  const runId = `mayura-live-${now}`;
  const event = (sequence, type, metadata) => ({ runId, sequence, timestamp: at(sequence), type, metadata });
  return { runId, spans: agentRunTraceSpans([
    event(1, 'run.started', { profile: 'ephemeral', agentId: 'mayura-live-check' }),
    event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
    event(3, 'model.completed', { step: 0, response: 'tool_calls', costMicros: 2, inputTokens: 40, outputTokens: 12 }),
    event(4, 'tool.started', { toolId: 'math.add', callId: 'call-1' }),
    event(5, 'tool.completed', { toolId: 'math.add', callId: 'call-1', status: 'succeeded' }),
    event(6, 'model.started', { step: 1, modelCall: 2, modelId: 'openai/gpt-test' }),
    event(7, 'model.completed', { step: 1, response: 'final', costMicros: 1, inputTokens: 60, outputTokens: 5 }),
    event(8, 'run.completed', { status: 'succeeded', spentMicros: 3, reservedMicros: 0, calls: 2 }),
  ]) };
}

/** A fetch that remembers each response's HTTP status for the report. */
export function watchedFetch() {
  const statuses = [];
  const fetcher = async (input, init) => { const response = await fetch(input, init); statuses.push(response.status); return response; };
  return { fetcher, statuses };
}

/** Exports the run with `exporter` (made with `fetch` from watchedFetch) and records the outcome under `name`. */
export async function exportCheck(results, name, make) {
  const { fetcher, statuses } = watchedFetch();
  const { runId, spans } = runSpans();
  let exporter;
  try {
    exporter = make(fetcher);
    await exporter.sink(spans, { signal: AbortSignal.timeout(30_000) });
    console.log(`  ${name}: run ${runId}, ${spans.length} spans, HTTP ${statuses.join(', ')}, ${JSON.stringify(exporter.inspect().metrics)}`);
    results.push([name, 'passed']);
  } catch (error) {
    console.log(`  ${name}: HTTP ${statuses.join(', ') || 'none'}${exporter ? `, ${JSON.stringify(exporter.inspect().metrics)}` : ''}`);
    results.push([name, `FAILED: ${error.code ?? ''} ${String(error.message).slice(0, 160)}`]);
  }
}

export function report(results) {
  for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
  process.exitCode = results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0;
}
