// Shared by the provider-*.mjs live checks: the same agent checks through a model registry, for any provider package.
// Prints outcomes, cost and call counts only; never a key, a prompt or a model's reply beyond the checked value.
const { createModels, createRuntime, defineAgent, defineTool, z } = await import(new URL('../../packages/mayura/dist/index.js', import.meta.url).href);

/**
 * Runs a structured answer and a tool call on `modelId` through `provider`, priced from the provider's catalog (or the
 * prices given), within `maxCostMicros` per run. Returns [name, outcome] pairs.
 */
export async function modelChecks({ provider, modelId, prices = 'catalog', maxCallCostMicros = 50_000, maxCostMicros = 200_000 }) {
  const models = createModels({ providers: [provider], prices, maxCallCostMicros });
  const results = [];
  const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
  const run = async (agent, input, allow) => {
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: [`model:${modelId}`, ...allow] }, limits: { maxCostMicros } });
    try {
      const handle = runtime.submit(agent, { input });
      const result = await handle.result();
      const budget = runtime.inspect(handle).budget;
      const error = result.error ? `, ${result.error.code}: ${String(result.error.message ?? '').slice(0, 160)}` : '';
      console.log(`  ${agent.id}: ${result.status}, ${budget?.calls ?? '?'} model calls, ${budget?.spentMicros ?? '?'} micros${error}`);
      return result;
    } finally { await runtime.close(); }
  };

  await check('answers with a structured output', async () => {
    const agent = defineAgent({
      id: 'live-structured', version: '1', instructions: 'Answer the question. Reply with the number only.', tools: [],
      model: models.model(modelId), input: z.object({ question: z.string() }), output: z.object({ answer: z.number() }),
    });
    const result = await run(agent, { question: 'What is 17 plus 25?' }, []);
    if (result.status !== 'succeeded' || result.output?.answer !== 42) throw new Error(`status ${result.status}, answer ${JSON.stringify(result.output?.answer)}`);
  });
  await check('calls a tool and answers with its result', async () => {
    let calls = 0;
    const add = defineTool({
      id: 'math.add', version: '1', description: 'Add two numbers.', effects: 'none', capabilities: [],
      input: z.object({ left: z.number(), right: z.number() }), output: z.object({ sum: z.number() }),
      execute: ({ left, right }) => { calls++; return { sum: left + right }; },
    });
    const agent = defineAgent({
      id: 'live-tool', version: '1', instructions: 'Use the math.add tool to add the two numbers, then answer with the sum it returns.',
      tools: [add], model: models.model(modelId), input: z.object({ left: z.number(), right: z.number() }), output: z.object({ answer: z.number() }),
    });
    const result = await run(agent, { left: 1234, right: 4321 }, ['tool:math.add']);
    if (result.status !== 'succeeded' || calls < 1 || result.output?.answer !== 5555) throw new Error(`status ${result.status}, ${calls} tool calls, answer ${JSON.stringify(result.output?.answer)}`);
  });
  return results;
}

/** Prints each outcome and sets the exit code: 0 only when every check passed. */
export function report(results) {
  for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
  process.exitCode = results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0;
}
