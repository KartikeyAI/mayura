import { MayuraError } from '@mayura/core';
import type { FileStore } from '@mayura/files';

/** What the file store cases run against: a store they may write to under fresh prefixes. */
export interface FileStoreHarness {
  /** A store to test. Each case works under its own new prefix (`within`), so one bucket can serve every case. */
  readonly store: FileStore;
  /** Cases this backend cannot run, with the reason; they are reported as skipped. */
  readonly skip?: Readonly<Record<string, string>>;
}
export interface FileStoreConformanceCase {
  readonly name: string;
  /** Runs the case; throws an `Error` describing the first broken expectation. */
  run(harness: FileStoreHarness): Promise<'passed' | 'skipped'>;
}

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function failure(run: () => Promise<unknown>): Promise<unknown> { try { await run(); } catch (error) { return error; } throw new Error('The call must fail.'); }
const conflict = (error: unknown) => error instanceof MayuraError && error.code === 'CONFLICT';
const text = (value: string) => new TextEncoder().encode(value);
const same = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
let sequence = 0;
const fresh = (store: FileStore) => store.within(`conformance-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

const cases: readonly (readonly [string, (store: FileStore) => Promise<void>, ('conditional' | 'conditional-delete')?])[] = [
  ['writes and reads back bytes, media type and metadata', async store => {
    const data = new Uint8Array(256).map((_, index) => index);
    const written = await store.put('a/b/data.bin', data, { contentType: 'application/x-test', metadata: { owner: 'acme', 'run-id': 'r-1' } });
    check(written.key === 'a/b/data.bin' && written.size === 256 && typeof written.etag === 'string' && written.etag.length > 0, 'put must return the key, size and an etag.');
    const file = await store.get('a/b/data.bin');
    check(file !== undefined && same(file.data, data), 'get must return the bytes written, every byte value intact.');
    check(file.size === 256 && file.etag === written.etag, 'get must report the size and the etag put returned.');
    check(file.contentType?.split(';')[0] === 'application/x-test', 'get must report the media type written.');
    check(file.metadata?.['owner'] === 'acme' && file.metadata?.['run-id'] === 'r-1', 'get must return the metadata written.');
    const info = await store.head('a/b/data.bin');
    check(info !== undefined && info.size === 256 && info.etag === written.etag && info.metadata?.['owner'] === 'acme', 'head must describe the file.');
  }],
  ['stores an empty file', async store => {
    await store.put('empty', new Uint8Array(0));
    const file = await store.get('empty');
    check(file !== undefined && file.data.byteLength === 0 && file.size === 0, 'An empty file must read back empty, not missing.');
  }],
  ['reports a missing file as undefined', async store => {
    check(await store.get('missing') === undefined, 'get of a missing file must be undefined.');
    check(await store.head('missing') === undefined, 'head of a missing file must be undefined.');
  }],
  ['replaces a file and gives it a new etag', async store => {
    const first = await store.put('file.txt', text('one'));
    const second = await store.put('file.txt', text('two'));
    check(second.etag !== first.etag, 'A replaced file must have a new etag.');
    const file = await store.get('file.txt');
    check(file !== undefined && new TextDecoder().decode(file.data) === 'two', 'get must return the latest content.');
  }],
  ['creates only when absent with ifNoneMatch', async store => {
    await store.put('once.txt', text('first'), { ifNoneMatch: '*' });
    check(conflict(await failure(() => store.put('once.txt', text('second'), { ifNoneMatch: '*' }))), 'A second create-only write must fail with CONFLICT.');
    const file = await store.get('once.txt');
    check(file !== undefined && new TextDecoder().decode(file.data) === 'first', 'A refused write must not change the file.');
  }, 'conditional'],
  ['replaces only the version given with ifMatch', async store => {
    const first = await store.put('cas.txt', text('v1'));
    const second = await store.put('cas.txt', text('v2'), { ifMatch: first.etag });
    check(conflict(await failure(() => store.put('cas.txt', text('v3'), { ifMatch: first.etag }))), 'A write with a stale etag must fail with CONFLICT.');
    check(conflict(await failure(() => store.put('absent.txt', text('v1'), { ifMatch: second.etag }))), 'A write with ifMatch to a missing file must fail with CONFLICT.');
    const file = await store.get('cas.txt', { ifMatch: second.etag });
    check(file !== undefined && new TextDecoder().decode(file.data) === 'v2', 'A read with the current etag must succeed.');
    check(conflict(await failure(() => store.get('cas.txt', { ifMatch: first.etag }))), 'A read with a stale etag must fail with CONFLICT.');
  }, 'conditional'],
  ['reads ranges and reports the whole size', async store => {
    await store.put('range.txt', text('0123456789'));
    const middle = await store.get('range.txt', { range: { offset: 2, length: 3 } });
    check(middle !== undefined && new TextDecoder().decode(middle.data) === '234' && middle.size === 10, 'A range must return its bytes and the whole size.');
    const tail = await store.get('range.txt', { range: { offset: 7 } });
    check(tail !== undefined && new TextDecoder().decode(tail.data) === '789', 'A range without length must read to the end.');
    const past = await store.get('range.txt', { range: { offset: 8, length: 10 } });
    check(past !== undefined && new TextDecoder().decode(past.data) === '89', 'A range past the end must stop at the end.');
    const beyond = await store.get('range.txt', { range: { offset: 10 } });
    check(beyond !== undefined && beyond.data.byteLength === 0 && beyond.size === 10, 'A range starting at the end must be empty, with the size.');
  }],
  ['lists by prefix in key order, page by page', async store => {
    const keys = ['docs/a.txt', 'docs/b.txt', 'docs/c/d.txt', 'docs/e.txt', 'docs/f.txt', 'other/x.txt'];
    for (const key of keys) await store.put(key, text(key));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page = await store.list({ prefix: 'docs/', limit: 2, ...(cursor ? { cursor } : {}) });
      check(page.files.length <= 2, 'A page must hold at most limit files.');
      for (const file of page.files) { check(file.size === new TextEncoder().encode(file.key).byteLength && typeof file.etag === 'string', 'Listed files must have their size and etag.'); seen.push(file.key); }
      cursor = page.cursor; pages++;
      check(pages <= 10, 'Listing must end.');
    } while (cursor);
    check(JSON.stringify(seen) === JSON.stringify(keys.slice(0, 5)), `Listing must return every key under the prefix once, in order, not ${JSON.stringify(seen)}.`);
    const all = await store.list({ limit: 100 });
    check(all.files.length === 6 && all.cursor === undefined, 'Listing without a prefix must return every file in the view.');
    const none = await store.list({ prefix: 'nothing/' });
    check(none.files.length === 0 && none.cursor === undefined, 'Listing an empty prefix must return nothing.');
  }],
  ['keeps keys with spaces, symbols and other scripts intact', async store => {
    const keys = ['with space.txt', 'plus+sign.txt', 'percent%20.txt', 'amp&lt;.txt', 'ünïcödé/файл.txt', '中文/文件.txt', 'emoji-😀.txt', 'quote\'s "file".txt', 'semi;colon=equals?.txt'];
    for (const key of keys) await store.put(key, text(key));
    for (const key of keys) {
      const file = await store.get(key);
      check(file !== undefined && new TextDecoder().decode(file.data) === key, `The key ${JSON.stringify(key)} must read back its own file.`);
    }
    const listed = (await store.list({ limit: 100 })).files.map(file => file.key).sort();
    check(JSON.stringify(listed) === JSON.stringify([...keys].sort()), `Listing must return each key exactly as written, not ${JSON.stringify(listed)}.`);
  }],
  ['deletes files, and deleting a missing file succeeds', async store => {
    await store.put('gone.txt', text('bye'));
    await store.delete('gone.txt');
    check(await store.get('gone.txt') === undefined, 'A deleted file must be missing.');
    await store.delete('gone.txt');
    await store.delete('never-was.txt');
  }],
  ['deletes only the version given with ifMatch', async store => {
    const first = await store.put('guarded.txt', text('v1'));
    const second = await store.put('guarded.txt', text('v2'));
    check(conflict(await failure(() => store.delete('guarded.txt', { ifMatch: first.etag }))), 'A delete with a stale etag must fail with CONFLICT.');
    check(await store.get('guarded.txt') !== undefined, 'A refused delete must keep the file.');
    await store.delete('guarded.txt', { ifMatch: second.etag });
    check(await store.get('guarded.txt') === undefined, 'A delete with the current etag must delete.');
  }, 'conditional-delete'],
  ['keeps views apart', async store => {
    const left = store.within('left'); const right = store.within('right');
    await left.put('same.txt', text('left'));
    await right.put('same.txt', text('right'));
    check(new TextDecoder().decode((await left.get('same.txt'))!.data) === 'left', 'A view must read its own file.');
    check((await left.list()).files.every(file => file.key === 'same.txt') && (await left.list()).files.length === 1, 'A view must list only its own files, with relative keys.');
    await left.delete('same.txt');
    check(await right.get('same.txt') !== undefined, 'Deleting in one view must not touch another.');
  }],
  ['stops before calling the store when already cancelled', async store => {
    const controller = new AbortController(); controller.abort();
    const error = await failure(() => store.put('cancelled.txt', text('x'), { signal: controller.signal }));
    check(error instanceof MayuraError && error.code === 'CANCELLED', 'A cancelled call must fail with CANCELLED.');
    check(await store.get('cancelled.txt') === undefined, 'A cancelled write must not happen.');
  }],
];

/**
 * The file store contract as test cases: round trips, preconditions, ranges, listing, keys, deletes, views and
 * cancellation. A backend package runs them against a real service or a faithful emulator:
 * `for (const test of fileStoreConformance) it(test.name, async () => expect(await test.run({ store })).toBe('passed'))`.
 * Cases a store's `conditionalWrites` or `conditionalDelete` rule out report `skipped`.
 */
export const fileStoreConformance: readonly FileStoreConformanceCase[] = cases.map(([name, body, needs]) => Object.freeze({
  name,
  run: async (harness: FileStoreHarness): Promise<'passed' | 'skipped'> => {
    if (harness.skip?.[name] !== undefined) return 'skipped';
    if ((needs === 'conditional' && !harness.store.conditionalWrites) || (needs === 'conditional-delete' && !harness.store.conditionalDelete)) return 'skipped';
    await body(fresh(harness.store));
    return 'passed';
  },
}));
