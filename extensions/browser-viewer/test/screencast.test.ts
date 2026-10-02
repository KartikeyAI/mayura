import { describe, expect, it } from 'vitest';
import { browserScreencast } from '../src/index.js';
import { fakeCdp, stubBrowser, until } from './fake.js';

describe('browserScreencast', () => {
  it('refuses settings and browsers it cannot use', async () => {
    const { browser } = stubBrowser(); const cdp = fakeCdp();
    for (const [option, value] of [['quality', 0], ['quality', 101], ['maxWidth', 100], ['maxHeight', 5_000], ['maxFps', 0], ['maxFps', 31], ['maxFrameBytes', 10]] as const) {
      await expect(browserScreencast(browser, { webSocket: cdp.factory, [option]: value }), option).rejects.toThrow(new RegExp(option, 'u'));
    }
    await expect(browserScreencast(browser, { webSocket: cdp.factory, interact: 'yes' as never })).rejects.toThrow(/interact/u);
    await expect(browserScreencast({} as never)).rejects.toThrow(/needs a browser/u);
    await expect(browserScreencast(stubBrowser({ unjoinable: true }).browser, { webSocket: cdp.factory })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('cannot be joined') });
    const ended = stubBrowser(); ended.state.ended = true;
    await expect(browserScreencast(ended.browser, { webSocket: cdp.factory })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(browserScreencast(browser, { webSocket: cdp.factory, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cdp.sent).toEqual([]);
  });

  it('shows the active tab: attached on a connection of its own, its frames asked for once taken, no faster than maxFps', async () => {
    const { browser } = stubBrowser(); const cdp = fakeCdp();
    const cast = await browserScreencast(browser, { webSocket: cdp.factory, quality: 70, maxWidth: 800, maxHeight: 600, maxFps: 4 });
    expect(cdp.sent.slice(0, 2)).toEqual([
      { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } },
      { method: 'Page.startScreencast', params: { format: 'jpeg', quality: 70, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 }, sessionId: 'S-T1' },
    ]);
    const first = cdp.frame('T1');
    await new Promise(resolve => setTimeout(resolve, 50));
    // Not taken yet, so not acknowledged: the browser sends no more.
    expect(cdp.acks()).toEqual([]);
    expect(await cast.next()).toEqual({ data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg', width: 1_000, height: 500, tab: 'T1' });
    await until(() => cdp.acks().length === 1);
    expect(cdp.acks()).toEqual([first]);
    const taken = cast.next(); const second = cdp.frame('T1');
    const started = Date.now();
    await taken;
    await until(() => cdp.acks().length === 2);
    // A quarter second after the first, at 4 frames a second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(cdp.acks()).toEqual([first, second]);
    await expect(Promise.all([cast.next(), cast.next()])).rejects.toThrow(/one frame at a time/u);
    cast.close();
  });

  it('skips frames that are too large, and frames of a tab no longer shown', { timeout: 10_000 }, async () => {
    const { browser, state } = stubBrowser(); const cdp = fakeCdp();
    const cast = await browserScreencast(browser, { webSocket: cdp.factory, maxFrameBytes: 65_536 });
    const big = cdp.frame('T1', new Uint8Array(70_000));
    await until(() => cdp.acks().includes(big));
    const garbled = cdp.garbled('T1');
    await until(() => cdp.acks().includes(garbled));
    state.tabs = ['T1', 'T2']; state.active = 'T2';
    await until(() => cdp.sent.some(item => item.method === 'Page.startScreencast' && item.sessionId === 'S-T2'), 3_000);
    expect(cdp.sent.find(item => item.method === 'Target.detachFromTarget')).toEqual({ method: 'Target.detachFromTarget', params: { sessionId: 'S-T1' } });
    const taking = cast.next();
    cdp.frame('T1', new Uint8Array([1]));
    cdp.frame('T2', new Uint8Array([2]));
    expect(await taking).toMatchObject({ data: new Uint8Array([2]), tab: 'T2' });
    // The tab shown is attached once, however often the browser is asked which is active.
    await new Promise(resolve => setTimeout(resolve, 2_200));
    expect(cdp.sent.filter(item => item.method === 'Target.attachToTarget').map(item => item.params['targetId'])).toEqual(['T1', 'T2']);
    cast.close();
  });

  it('ends when its browser ends, when closed, or cancelled; a waiting reader gets nothing', async () => {
    const one = stubBrowser(); const cdp = fakeCdp();
    const cast = await browserScreencast(one.browser, { webSocket: cdp.factory });
    const waiting = cast.next();
    one.state.ended = true;
    expect(await waiting).toBeUndefined();
    expect(cast.ended).toBe(true); expect(cdp.open).toBe(0);
    const controller = new AbortController();
    const two = await browserScreencast(stubBrowser().browser, { webSocket: cdp.factory, signal: controller.signal });
    controller.abort();
    expect(await two.next()).toBeUndefined();
    const three = await browserScreencast(stubBrowser().browser, { webSocket: cdp.factory });
    const frames: unknown[] = [];
    const reading = (async () => { for await (const frame of three) frames.push(frame); })();
    cdp.frame('T1'); await until(() => frames.length === 1);
    three.close(); await reading;
    expect(cdp.open).toBe(0);
  });

  it('ends after the browser stops answering, and when its connection closes', async () => {
    const one = stubBrowser(); const cdp = fakeCdp();
    const cast = await browserScreencast(one.browser, { webSocket: cdp.factory });
    one.state.failTabs = true;
    await until(() => cast.ended, 5_000);
    const two = await browserScreencast(stubBrowser().browser, { webSocket: cdp.factory });
    cdp.sockets.at(-1)!.close();
    expect(await two.next()).toBeUndefined();
  }, 10_000);

  it('takes input only with interact, as the page shows it', async () => {
    const view = await browserScreencast(stubBrowser().browser, { webSocket: fakeCdp().factory });
    await expect(view.input({ type: 'text', text: 'x' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    view.close();
    const cdp = fakeCdp();
    const cast = await browserScreencast(stubBrowser().browser, { webSocket: cdp.factory, interact: true });
    await expect(cast.input({ type: 'text', text: 'x' })).rejects.toThrow(/No page is shown yet/u);
    cdp.frame('T1'); await cast.next();
    await cast.input({ type: 'mouse', action: 'down', x: 0.5, y: 0.25, button: 'left', clicks: 2, modifiers: 8 });
    await cast.input({ type: 'mouse', action: 'move', x: 1, y: 1 });
    await cast.input({ type: 'wheel', x: 0, y: 0, dx: 0, dy: 120 });
    await cast.input({ type: 'key', action: 'down', key: 'a' });
    await cast.input({ type: 'key', action: 'down', key: 'a', modifiers: 2 });
    await cast.input({ type: 'key', action: 'down', key: 'Enter' });
    await cast.input({ type: 'key', action: 'down', key: 'Backspace' });
    await cast.input({ type: 'key', action: 'up', key: 'Backspace' });
    await cast.input({ type: 'text', text: 'héllo' });
    expect(cdp.sent.filter(item => item.method.startsWith('Input.'))).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 500, y: 125, modifiers: 8, button: 'left', clickCount: 2 }, sessionId: 'S-T1' },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1_000, y: 500, modifiers: 0 }, sessionId: 'S-T1' },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: 120 }, sessionId: 'S-T1' },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a' }, sessionId: 'S-T1' },
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, sessionId: 'S-T1' },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r' }, sessionId: 'S-T1' },
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 }, sessionId: 'S-T1' },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 }, sessionId: 'S-T1' },
      { method: 'Input.insertText', params: { text: 'héllo' }, sessionId: 'S-T1' },
    ]);
    const refused: unknown[] = [
      null, { type: 'drag' }, { type: 'mouse', action: 'down', x: 2, y: 0 }, { type: 'mouse', action: 'down', x: 0, y: -0.1 }, { type: 'mouse', action: 'hold', x: 0, y: 0 },
      { type: 'mouse', action: 'down', x: 0, y: 0, button: 'back' }, { type: 'mouse', action: 'down', x: 0, y: 0, clicks: 4 }, { type: 'mouse', action: 'down', x: 0, y: 0, modifiers: 16 },
      { type: 'wheel', x: 0, y: 0, dx: 0, dy: 20_000 }, { type: 'wheel', x: 0, y: 0, dx: Number.NaN, dy: 0 },
      { type: 'key', action: 'press', key: 'a' }, { type: 'key', action: 'down', key: 'F5' }, { type: 'key', action: 'down', key: 'ab' }, { type: 'key', action: 'down', key: '\u0007' },
      { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(1_001) },
    ];
    const before = cdp.sent.length;
    for (const event of refused) await expect(cast.input(event as never), JSON.stringify(event)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(cdp.sent.length).toBe(before);
    cast.close();
    await expect(cast.input({ type: 'text', text: 'x' })).rejects.toThrow(/ended/u);
  });
});
