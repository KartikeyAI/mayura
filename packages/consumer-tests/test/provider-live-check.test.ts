import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// The live-provider harness is an .mjs script; its dry run is the offline, deterministic qualification of its own logic.
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/provider-live-check.mjs', import.meta.url));
const workspace = fileURLToPath(new URL('../../..', import.meta.url));
interface Check { check: string; status: string; reasons?: string[] }
interface ProviderReport { provider: string; status: string; reason?: string; checks: Check[] }
interface Report { status: string; mode: string; providers: ProviderReport[]; totals: { chargedMicros: number }; caps: { maxTotalCostMicros: number; plannedWorstCaseMicros: number } }
const harness = async () => await import(new URL('../../../scripts/provider-live-check.mjs', import.meta.url).href) as {
  runHarness(options: { env: Record<string, string>; mode?: string; transport?: (provider: unknown) => unknown }): Promise<Report>;
  readConfig(env: Record<string, string>): unknown;
  dryRunTransport(provider: unknown, fault?: string): unknown;
  DRY_RUN_ENV: Record<string, string>;
  Refusal: new (...args: never[]) => Error & { problems: string[] };
};
const dryRun = async (env?: Record<string, string>, fault?: string): Promise<Report> => {
  const { runHarness, dryRunTransport, DRY_RUN_ENV } = await harness();
  return await runHarness({ env: env ?? DRY_RUN_ENV, mode: 'dry-run', transport: provider => dryRunTransport(provider, fault) });
};
const statuses = (report: Report, provider = 0): Record<string, string> =>
  Object.fromEntries(report.providers[provider]!.checks.map(check => [check.check, check.status]));
const refusal = async (env: Record<string, string>): Promise<string[]> => {
  const { readConfig, Refusal } = await harness();
  try { readConfig(env); } catch (error) { if (error instanceof Refusal) return error.problems; throw error; }
  throw new Error('Expected the configuration to be refused.');
};
const credentials = (env: Record<string, string>): string[] => Object.entries(env).filter(([name]) => /_(?:KEY|TOKEN)$/u.test(name)).map(([, value]) => value);

describe('provider live-check harness (dry run)', () => {
  it('passes every check for every configured provider through the runtime, within the caps, without printing credentials', async () => {
    const { DRY_RUN_ENV } = await harness();
    const report = await dryRun();
    expect(report).toMatchObject({ status: 'passed', mode: 'dry-run' });
    expect(report.providers.map(provider => [provider.provider, provider.status])).toEqual([
      ['openai', 'passed'], ['anthropic', 'passed'], ['compatible:groq', 'passed'], ['compatible:azure', 'passed'],
      // A Cloudflare AI Gateway route to a DeepSeek-style model: gateway token, JSON mode, strict tools, reasoning sent back.
      ['compatible:cloudflare', 'passed']]);
    for (const provider of report.providers) {
      // The vision checks run for adapters that see images: OpenAI, Anthropic, and the compatible one given _MEDIA.
      const vision = ['openai', 'anthropic', 'compatible:groq'].includes(provider.provider) ? 'passed' : 'skipped';
      expect(provider.checks.map(check => [check.check, check.status])).toEqual([...['structured', 'tools', 'streaming', 'router_failover', 'router_streaming'].map(check => [check, 'passed']),
        ['vision', vision], ['vision_tools', vision], ['cost', 'passed']]);
      // The refused route is charged its full per-call bound (5,000) and the valid route its confirmed cost (480).
      for (const check of provider.checks.filter(entry => entry.check.startsWith('router_'))) expect(check).toMatchObject({ chargedMicros: 5_480, details: { confirmedMicros: 480 } });
    }
    expect(report.totals.chargedMicros).toBeGreaterThan(0);
    expect(report.totals.chargedMicros).toBeLessThanOrEqual(report.caps.plannedWorstCaseMicros);
    expect(report.caps.plannedWorstCaseMicros).toBeLessThanOrEqual(report.caps.maxTotalCostMicros);
    const printed = JSON.stringify(report);
    for (const credential of credentials(DRY_RUN_ENV)) expect(printed).not.toContain(credential);
  });

  it.each([
    ['ignore-tool-result', { tools: 'failed' }],
    ['single-chunk-stream', { streaming: 'failed', router_streaming: 'failed' }],
    ['accept-invalid-key', { router_failover: 'failed', router_streaming: 'failed' }],
    ['overcharge', { structured: 'failed', tools: 'failed', cost: 'failed' }],
    // A model that ignores images: both vision checks fail, since they need the number drawn in the image.
    ['blind', { vision: 'failed', vision_tools: 'failed' }],
  ])('fails the check that qualifies the behaviour a fault removes (%s)', async (fault, failed) => {
    const report = await dryRun(undefined, fault);
    expect(report.status).toBe('failed');
    expect(statuses(report)).toMatchObject(failed);
    if (fault !== 'overcharge') {
      expect(Object.values(statuses(report)).filter(status => status === 'failed')).toHaveLength(Object.keys(failed).length);
    } else {
      // A call over its bound blocks the run and stops the harness before it spends further.
      expect(report.providers[0]!.checks.find(check => check.check === 'tools')!.reasons).toEqual(['Not run: the total cost cap would be exceeded.']);
    }
  });

  it('reports unselected providers and checks as skipped, never as passed', async () => {
    const { DRY_RUN_ENV } = await harness();
    const openaiOnly = Object.fromEntries(Object.entries(DRY_RUN_ENV).filter(([name]) => !/ANTHROPIC|COMPATIBLE/u.test(name)));
    const report = await dryRun({ ...openaiOnly, MAYURA_LIVE_CHECKS: 'structured,streaming' });
    expect(report.status).toBe('passed');
    expect(report.providers.map(provider => [provider.provider, provider.status])).toEqual([['openai', 'passed'], ['anthropic', 'skipped'], ['compatible', 'skipped']]);
    expect(report.providers[1]).toMatchObject({ reason: 'MAYURA_LIVE_ANTHROPIC_MODEL is not set.', checks: [] });
    expect(statuses(report)).toEqual({ structured: 'passed', tools: 'skipped', streaming: 'passed', router_failover: 'skipped', router_streaming: 'skipped',
      vision: 'skipped', vision_tools: 'skipped', cost: 'passed' });
    expect(report.caps.plannedWorstCaseMicros).toBe(2 * 5_000);
  });
});

describe('provider live-check harness (configuration)', () => {
  const caps = { MAYURA_LIVE_MAX_CALL_COST_MICROS: '1000', MAYURA_LIVE_MAX_TOTAL_COST_MICROS: '100000' };
  const openai = { MAYURA_LIVE_OPENAI_MODEL: 'model', OPENAI_API_KEY: 'fixture-credential-value',
    MAYURA_LIVE_OPENAI_INPUT_MICROS_PER_MILLION_TOKENS: '1', MAYURA_LIVE_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS: '1' };

  it('refuses to run without explicit caps, prices and credentials, naming variables but never values', async () => {
    expect(await refusal({ ...openai, OPENAI_API_KEY: 'x' })).toEqual(expect.arrayContaining(['MAYURA_LIVE_MAX_CALL_COST_MICROS is required.', 'MAYURA_LIVE_MAX_TOTAL_COST_MICROS is required.']));
    expect(await refusal({ ...caps, MAYURA_LIVE_OPENAI_MODEL: 'model' })).toEqual(expect.arrayContaining(['OPENAI_API_KEY is required for the selected provider.',
      'MAYURA_LIVE_OPENAI_INPUT_MICROS_PER_MILLION_TOKENS is required.']));
    expect(await refusal({ ...caps, ...openai, MAYURA_LIVE_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS: '0' })).toEqual(['MAYURA_LIVE_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS must be a positive integer.']);
    expect(await refusal(caps)).toEqual([expect.stringContaining('No provider is selected')]);
    // A credential alone never selects a provider.
    expect(await refusal({ ...caps, OPENAI_API_KEY: 'fixture-credential-value' })).toEqual([expect.stringContaining('No provider is selected')]);
    const problems = await refusal({ ...caps, ...openai, MAYURA_LIVE_MAX_TOTAL_COST_MICROS: '1000' });
    expect(problems).toEqual([expect.stringContaining('below the planned worst case of 13000 micros')]);
    // A native provider through a gateway: the token needs the gateway's endpoint, and then the provider key is optional.
    const viaGateway = { ...caps, MAYURA_LIVE_ANTHROPIC_MODEL: 'model', MAYURA_LIVE_ANTHROPIC_GATEWAY_TOKEN: 'fixture-credential-value',
      MAYURA_LIVE_ANTHROPIC_INPUT_MICROS_PER_MILLION_TOKENS: '1', MAYURA_LIVE_ANTHROPIC_OUTPUT_MICROS_PER_MILLION_TOKENS: '1' };
    expect(await refusal(viaGateway)).toEqual(expect.arrayContaining([expect.stringContaining('MAYURA_LIVE_ANTHROPIC_GATEWAY_TOKEN needs MAYURA_LIVE_ANTHROPIC_URL')]));
    const { readConfig } = await harness();
    expect(() => readConfig({ ...viaGateway, MAYURA_LIVE_ANTHROPIC_URL: 'https://gateway.ai.cloudflare.com/v1/account/default/anthropic/v1/messages' })).not.toThrow();
    expect(JSON.stringify(problems)).not.toContain('fixture-credential-value');
  });

  it('refuses a remote compatible provider the adapter would refuse, before any request', async () => {
    const problems = await refusal({ ...caps, MAYURA_LIVE_COMPATIBLE: 'acme', MAYURA_LIVE_COMPATIBLE_ACME_URL: 'http://api.acme.example/v1/chat/completions',
      MAYURA_LIVE_COMPATIBLE_ACME_KEY: 'fixture-credential-value', MAYURA_LIVE_COMPATIBLE_ACME_MODEL: 'model',
      MAYURA_LIVE_COMPATIBLE_ACME_INPUT_MICROS_PER_MILLION_TOKENS: '1', MAYURA_LIVE_COMPATIBLE_ACME_OUTPUT_MICROS_PER_MILLION_TOKENS: '1' });
    expect(problems).toEqual([expect.stringMatching(/^MAYURA_LIVE_COMPATIBLE_ACME configuration was refused by the adapter: /u)]);
    expect(await refusal({ ...caps, MAYURA_LIVE_COMPATIBLE: 'Bad_Id' })).toEqual([expect.stringContaining('lower-case provider ids'), expect.stringContaining('No provider is selected')]);
  });

  it('accepts a gateway token instead of a provider key, and refuses unknown dialect settings', async () => {
    const gateway = { ...caps, MAYURA_LIVE_COMPATIBLE: 'cloudflare', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions',
      MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_MODEL: 'deepseek/deepseek-flash', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_INPUT_MICROS_PER_MILLION_TOKENS: '1',
      MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_OUTPUT_MICROS_PER_MILLION_TOKENS: '1' };
    expect(await refusal(gateway)).toEqual(['MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_KEY is required for the selected provider.']);
    const { readConfig } = await harness();
    expect(() => readConfig({ ...gateway, MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_GATEWAY_TOKEN: 'fixture-credential-value' })).not.toThrow();
    const problems = await refusal({ ...gateway, MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_GATEWAY_TOKEN: 'fixture-credential-value', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_OUTPUT: 'yaml',
      MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_STRICT_TOOLS: 'yes', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_BODY: '[1]', MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_TOKEN_LIMIT_FIELD: 'max' });
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('_OUTPUT must be json_schema or json_object'), expect.stringContaining('_STRICT_TOOLS must be true or false'),
      expect.stringContaining('_BODY must be a JSON object'), expect.stringContaining('_TOKEN_LIMIT_FIELD must be max_tokens or max_completion_tokens')]));
    expect(JSON.stringify(problems)).not.toContain('fixture-credential-value');
  });

  it('exits 0 for a passing dry run and 2 for a refused live run, which prints nothing on stdout', async () => {
    const passed = await exec(process.execPath, [script, '--dry-run'], { cwd: workspace, windowsHide: true, timeout: 30_000, maxBuffer: 1_048_576 });
    expect(JSON.parse(passed.stdout)).toMatchObject({ status: 'passed', mode: 'dry-run' });
    // A minimal explicit environment: the refusal happens before any provider is contacted.
    const env = { ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}), ...openai };
    const refused = await exec(process.execPath, [script], { cwd: workspace, windowsHide: true, timeout: 30_000, env }).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(refused).toMatchObject({ code: 2, stdout: '' });
    expect(JSON.parse((refused as { stderr: string }).stderr)).toMatchObject({ status: 'refused' });
    expect((refused as { stderr: string }).stderr).not.toContain('fixture-credential-value');
    const misuse = await exec(process.execPath, [script, '--dry-run-fault=overcharge'], { cwd: workspace, windowsHide: true, timeout: 30_000 }).catch((error: { code: number }) => error);
    expect(misuse).toMatchObject({ code: 2 });
  });
});
