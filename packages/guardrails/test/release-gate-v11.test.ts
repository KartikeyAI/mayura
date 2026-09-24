import { describe, expect, it, vi } from 'vitest';
import {
  Budget,
  ModelInvocationError,
  type GuardContext,
  type JsonValue,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from '@mayura/core';
import {
  detectAndTranslate,
  type ContentSnapshot,
  type LanguageDocument,
  type LanguageResult,
} from '../src/index.js';

const document: LanguageDocument = {
  segments: [
    { id: 'prose', kind: 'prose', text: 'Bonjour' },
    { id: 'code', kind: 'protected', text: 'const customerId = "acct_7";' },
  ],
};

const context = (): GuardContext => ({
  runId: 'release-gate-v11',
  callId: 'language',
  scope: { principalId: 'release', projectId: 'mayura' },
  boundary: 'input',
  signal: new AbortController().signal,
});

const snapshot = (value: JsonValue): ContentSnapshot => ({ version: 1, digest: 'untrusted-caller-digest', value });
const final = (output: JsonValue, costMicros = 1): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const model = (id: string, generate: ModelAdapter['generate']): ModelAdapter => ({
  id,
  maxCostMicros: 1,
  capabilities: { tools: false, structuredOutput: true },
  generate,
});

describe('V11 language handling acceptance', () => {
  it('tracks separate detection/translation calls while preserving original prose and protected code', async () => {
    const requests: ModelRequest[] = []; const budget = new Budget(2, 2);
    const processor = detectAndTranslate({
      id: 'language', version: '1', targetLanguage: 'en', budget,
      permissions: { allow: ['model:language-detect', 'model:language-translate'] },
      detectionModel: model('language-detect', async request => {
        requests.push(request); return final({ language: 'fr', confidence: 0.99 });
      }),
      translationModel: model('language-translate', async request => {
        requests.push(request); return final({ segments: [{ id: 'prose', text: 'Hello' }] });
      }),
    });

    const result = await processor.process(snapshot(document as unknown as JsonValue), context()) as LanguageResult;
    expect(result).toMatchObject({
      status: 'translated', reason: 'translated', original: document,
      segments: [
        { id: 'prose', originalText: 'Bonjour', text: 'Hello', translated: true },
        { id: 'code', originalText: 'const customerId = "acct_7";', text: 'const customerId = "acct_7";', translated: false },
      ],
    });
    expect(result.evidence.map(item => item.modelId)).toEqual(['language-detect', 'language-translate']);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain('customerId');
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 2 });
  });

  it('applies the documented low-confidence preserve policy without dispatching translation', async () => {
    const translate = vi.fn(async () => final({ segments: [{ id: 'prose', text: 'unused' }] }));
    const budget = new Budget(2, 2);
    const processor = detectAndTranslate({
      id: 'language', version: '1', targetLanguage: 'en', minConfidence: 0.8, budget,
      permissions: { allow: ['model:language-detect', 'model:language-translate'] },
      detectionModel: model('language-detect', async () => final({ language: 'fr', confidence: 0.2 })),
      translationModel: model('language-translate', translate),
    });

    const result = await processor.process(snapshot(document as unknown as JsonValue), context()) as LanguageResult;
    expect(result).toMatchObject({ status: 'preserved', reason: 'low_confidence', original: document });
    expect(result.segments.map(segment => segment.text)).toEqual(document.segments.map(segment => segment.text));
    expect(result.evidence.map(item => item.modelId)).toEqual(['language-detect']);
    expect(translate).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('fails closed and accounts both calls when translation is unavailable', async () => {
    const budget = new Budget(2, 2);
    const processor = detectAndTranslate({
      id: 'language', version: '1', targetLanguage: 'en', budget,
      permissions: { allow: ['model:language-detect', 'model:language-translate'] },
      detectionModel: model('language-detect', async () => final({ language: 'fr', confidence: 0.99 })),
      translationModel: model('language-translate', async () => { throw new ModelInvocationError(1); }),
    });

    await expect(processor.process(snapshot(document as unknown as JsonValue), context()))
      .rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 2 });
  });
});
