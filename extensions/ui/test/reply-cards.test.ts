import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defineReplyCard, readReplyCards, ReplyCards, type ReplyCardsProps } from '../src/reply-cards.js';

function card(type: string, data: unknown, id = type) {
  return { id, type, title: 'Support reply', data };
}

function renderCards(input: unknown, props: Omit<ReplyCardsProps, 'cards'> = {}) {
  return renderToString(createElement(ReplyCards, { ...props, cards: readReplyCards(input) }));
}

describe('reply cards', () => {
  it('bounds and copies untrusted JSON while keeping the first valid occurrence of each ID', () => {
    const original = { rows: [[false, 0, null, 'text']] };
    const valid = card('detail', original, 'detail-one');
    const unsafe = JSON.parse('{"__proto__":{"inherited":true}}') as unknown;
    const accessor = Object.defineProperty({}, 'text', {
      enumerable: true,
      get() { throw new Error('A data accessor must never run'); },
    });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(readReplyCards([
      card('detail', unsafe, 'unsafe'), card('detail', accessor, 'accessor'), card('detail', cycle, 'cycle'),
      card('detail', Number.POSITIVE_INFINITY, 'number'), card('Detail', 'invalid type', 'invalid'),
      valid, card('detail', 'duplicate value', valid.id), card('detail', 'x'.repeat(2_049), 'long-text'),
    ])).toEqual([valid]);
    const copied = readReplyCards([valid]);
    original.rows[0]!.push('mutated');
    expect(copied[0]?.data).toEqual({ rows: [[false, 0, null, 'text']] });
    expect(readReplyCards(Array.from({ length: 9 }, () => valid))).toEqual([]);
  });

  it('renders escaped table cells and validated custom cards as text', () => {
    const custom = defineReplyCard('incident', {
      parse: data => typeof data === 'string' ? { incident: data } : undefined,
      Component: ({ data }) => createElement('p', null, data.incident),
    });
    const html = renderCards([
      card('table', { columns: ['Service', 'Count'], rows: [['<b>Logs</b>', 0], ['Alerts', null]] }),
      card('incident', '<em>Incident</em>'), card('incident', {}, 'invalid-data'),
      card('unknown-widget', { message: 'custom only' }),
    ], { renderers: [custom] });
    expect(html).toContain('scope="col"');
    expect(html).toContain('&lt;b&gt;Logs&lt;/b&gt;');
    expect(html).toContain('&lt;em&gt;Incident&lt;/em&gt;');
    expect(html.match(/This card is unavailable\./gu)).toHaveLength(2);
    expect(() => defineReplyCard('table', {
      parse: () => null,
      Component: () => null,
    })).toThrow(TypeError);
  });

  it('rejects malformed tables and permits only registered, canonical same-origin downloads', () => {
    const path = '/downloads/status.csv';
    const rejected = [
      '//elsewhere.test/status.csv', '/downloads/../status.csv', '/downloads/%2e%2e/status.csv',
      '/downloads\\status.csv', '/downloads/status.csv?other=1', 'https://elsewhere.test/status.csv',
      '/downloads/unlisted.csv',
    ];
    const html = renderCards([
      card('table', { columns: ['A', 'B'], rows: [[1]] }),
      ...rejected.map((candidate, index) => card('download', { path: candidate }, 'download-' + index)),
    ], { downloadPaths: rejected.slice(0, -1) });
    expect(html).not.toContain('<table');
    expect(html).not.toContain('href=');
    expect(renderCards([card('download', { path, filename: 'status.csv' })], { downloadPaths: [path] }))
      .toContain('href="/downloads/status.csv" download="status.csv"');
    expect(renderCards([card('download', { path, filename: '../status.csv' })], { downloadPaths: [path] }))
      .not.toContain('href=');
  });

  it.each(['success', 'unconfirmed'] as const)('requires the exact host action and submits it once on %s', async outcome => {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = dom.window.document.querySelector('#root')!;
    const root = createRoot(container);
    const binding = { cardId: 'incident-confirm', actionId: 'acknowledge' };
    const cards = readReplyCards([
      card('confirmation', { message: 'Can we acknowledge incident 19?', actionId: binding.actionId }, binding.cardId),
      card('confirmation', { message: 'Another card cannot reuse the action.', actionId: binding.actionId }, 'other-card'),
    ]);
    const onConfirm = vi.fn(async () => {
      if (outcome === 'unconfirmed') throw new Error('No acknowledgement.');
    });
    const props = { cards, onConfirm, confirmActions: [{ ...binding, label: 'Acknowledge incident 19',
      description: 'Record a single acknowledgement for incident 19.' }] };
    try {
      expect(renderToString(createElement(ReplyCards, props))).toContain(props.confirmActions[0]!.description);
      await act(async () => { root.render(createElement(ReplyCards, props)); });
      expect(onConfirm).not.toHaveBeenCalled();
      expect(container.querySelectorAll('form')).toHaveLength(1);
      const form = container.querySelector('form')!;
      const submit = () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await act(async () => { submit(); submit(); });
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith(binding);
      expect(container.querySelector('[role="status"]')?.textContent)
        .toBe(outcome === 'success' ? 'Confirmed.' : 'Could not confirm the outcome.');
      expect(container.querySelector('button')?.disabled).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });
});
