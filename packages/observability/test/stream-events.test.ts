import { describe, expect, it } from 'vitest';
import { eventSnapshot } from '../src/validation.js';

const base = { runId: 'run-1', sequence: 4, timestamp: new Date(0).toISOString() };

describe('streamed output events', () => {
  it('keep position and size but never the released text', () => {
    const snapshot = eventSnapshot({ ...base, type: 'output.delta', metadata: { step: 0, modelCall: 1, index: 2, text: 'PRIVATE reply text '.repeat(300) } });
    expect(snapshot.metadata).toEqual({ step: 0, modelCall: 1, index: 2, characters: 19 * 300 });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(eventSnapshot({ ...base, type: 'output.withheld', metadata: { step: 0, modelCall: 1 } }).metadata).toEqual({ step: 0, modelCall: 1 });
  });

  it('refuse malformed stream metadata', () => {
    expect(() => eventSnapshot({ ...base, type: 'output.delta', metadata: { step: 0, modelCall: 1, index: 0, text: 3 } })).toThrow();
    expect(() => eventSnapshot({ ...base, type: 'output.delta', metadata: { step: 0, modelCall: 1, index: 0, characters: 5 } })).toThrow();
    expect(() => eventSnapshot({ ...base, type: 'output.withheld', metadata: { step: 0, modelCall: 1, text: 'x' } })).toThrow();
  });
});
