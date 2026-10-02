import { describe, expect, it } from 'vitest';
import { parseKeys } from '../src/keys.js';
import { originPolicy } from '../src/origins.js';
import { outline, type AxNode } from '../src/snapshot.js';

describe('originPolicy', () => {
  it('allows only the listed origins: scheme, host and port', () => {
    const policy = originPolicy(['https://example.com', 'http://127.0.0.1:8080', 'https://*.docs.example.org']);
    for (const url of ['https://example.com/', 'https://example.com:443/a?b', 'http://127.0.0.1:8080/x', 'https://api.docs.example.org/', 'wss://example.com/socket']) expect(policy.allows(url), url).toBe(true);
    for (const url of ['http://example.com/', 'https://example.com:8443/', 'https://www.example.com/', 'http://127.0.0.1:8081/', 'http://localhost:8080/', 'http://example.com:443/',
      'https://docs.example.org/', 'https://evil-docs.example.org/', 'https://example.com.evil.net/', 'file:///etc/passwd', 'chrome://settings', 'not a url']) expect(policy.allows(url), url).toBe(false);
  });

  it('lets local schemes through, which never reach the network', () => {
    const policy = originPolicy(['https://example.com']);
    for (const url of ['about:blank', 'data:text/html,hi', 'blob:https://example.com/1']) expect(policy.allows(url)).toBe(true);
  });

  it("allows nothing by default, and every http(s) URL with 'all'", () => {
    for (const value of [undefined, [], 'some', ['example.com'], ['https://exa mple.com'], ['https://example.com/path'], ['https://*'], ['http://host:70000']]) {
      expect(() => originPolicy(value), JSON.stringify(value)).toThrow(/origins/u);
    }
    const all = originPolicy('all');
    expect(all.allows('https://anything.example/')).toBe(true);
    expect(all.allows('file:///etc/passwd')).toBe(false);
  });
});

describe('outline', () => {
  const node = (nodeId: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });
  const tree: AxNode[] = [
    node('1', 'RootWebArea', 'Home', { childIds: ['2', '3', '6', '8'] }),
    node('2', 'heading', 'Welcome', { parentId: '1', childIds: ['2t'] }),
    node('2t', 'StaticText', 'Welcome', { parentId: '2' }),
    node('3', 'generic', '', { parentId: '1', childIds: ['4', '5'] }),
    node('4', 'link', 'Next  page', { parentId: '3', backendDOMNodeId: 40 }),
    node('5', 'textbox', 'Query', { parentId: '3', backendDOMNodeId: 50, value: { value: 'old' }, properties: [{ name: 'focused', value: { value: true } }] }),
    node('6', 'checkbox', 'Agree', { parentId: '1', backendDOMNodeId: 60, properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'disabled', value: { value: true } }] }),
    node('8', 'paragraph', '', { parentId: '1', ignored: true, childIds: ['9'] }),
    node('9', 'StaticText', 'Some text', { parentId: '8' }),
  ];

  it('shows meaningful nodes by depth, with refs on the ones to act on', () => {
    const result = outline(tree, 10_000);
    expect(result.text).toBe([
      '- heading "Welcome"',
      '- link "Next page" [ref=e1]',
      '- textbox "Query" value="old" [focused] [ref=e2]',
      '- checkbox "Agree" [checked] [disabled] [ref=e3]',
      '- text "Some text"',
    ].join('\n'));
    expect([...result.refs]).toEqual([['e1', 40], ['e2', 50], ['e3', 60]]);
    expect(result.truncated).toBe(false);
  });

  it('stops at its size, saying so, with refs only for what it showed', () => {
    const result = outline(tree, 50);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('- heading "Welcome"\n- link "Next page" [ref=e1]');
    expect([...result.refs.keys()]).toEqual(['e1']);
    expect([...outline(tree, 45).refs.keys()]).toEqual([]);
  });

  it('survives cycles and missing children', () => {
    const cyclic: AxNode[] = [node('1', 'RootWebArea', '', { childIds: ['2', 'missing'] }), node('2', 'button', 'Go', { parentId: '1', childIds: ['1'], backendDOMNodeId: 2 })];
    expect(outline(cyclic, 1_000).text).toBe('- button "Go" [ref=e1]');
  });
});

describe('parseKeys', () => {
  it('reads keys and chords', () => {
    expect(parseKeys('Enter')).toEqual({ key: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, modifiers: 0 });
    expect(parseKeys('Control+a')).toEqual({ key: { key: 'a', code: 'KeyA', keyCode: 65 }, modifiers: 2 });
    expect(parseKeys('Shift+Tab').modifiers).toBe(8);
    expect(parseKeys('Shift+A').key.text).toBe('A');
    expect(parseKeys('7').key).toMatchObject({ code: 'Digit7', text: '7' });
  });

  it('refuses what is not a key', () => {
    for (const value of ['', 'Ctrl+a', 'Control+', 'F13', 'Enter+Control', 'é', 'x'.repeat(65), 42]) expect(() => parseKeys(value), String(value)).toThrow();
  });
});
