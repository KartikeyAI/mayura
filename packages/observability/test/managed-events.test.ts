import { describe, expect, it } from 'vitest';
import { eventSnapshot } from '../src/validation.js';

const metadata = { purpose: 'guardrail', modelId: 'moderator', checkId: 'policy', checkVersion: '1', boundary: 'output', callId: 'model.1' };
function event(type: string, fields: Record<string, unknown>) {
  return { runId: 'run', sequence: 1, timestamp: '2026-09-20T00:00:00.000Z', type, metadata: fields };
}

describe('metadata-only managed model observations', () => {
  it('accepts a managed dispatch without inventing an agent reasoning step', () => {
    const value = event('model.started', { ...metadata, modelCall: 2 });
    expect(eventSnapshot(value, 'run')).toEqual(value);
  });
  it.each(['allow', 'block'])('accepts a complete bounded %s verdict without raw categories', decision => {
    const value = event('model.completed', { ...metadata, response: 'final', decision });
    expect(eventSnapshot(value, 'run')).toEqual(value);
  });
  it.each([
    { purpose: 'unknown' }, { modelId: '' }, { checkId: 'raw secret with spaces' }, { checkVersion: '' },
    { boundary: 'other' }, { callId: '' }, { modelCall: 0 }, { input: 'private' }, { step: 1 }, { categories: 'private' },
  ])('rejects invalid or extra managed dispatch metadata %j', overrides => {
    expect(() => eventSnapshot(event('model.started', { ...metadata, modelCall: 2, ...overrides }), 'run')).toThrow();
  });
  it('rejects a purported managed tool proposal or noncanonical verdict', () => {
    expect(() => eventSnapshot(event('model.completed', { ...metadata, response: 'tool_calls', decision: 'allow' }), 'run')).toThrow();
    expect(() => eventSnapshot(event('model.completed', { ...metadata, response: 'final', decision: 'maybe' }), 'run')).toThrow();
  });
});
