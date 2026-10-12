// Shared by the filestorage-*.mjs live checks: the file store conformance suite on a real bucket, under a fresh prefix
// that is emptied afterwards. Prints outcomes only; never a key or a file's contents.
const { createFileStore } = await import(new URL('../../packages/mayura/dist/files.js', import.meta.url).href);
const { fileStoreConformance } = await import(new URL('../../packages/mayura/dist/testing.js', import.meta.url).href);

/** Runs every conformance case on `backend` (`skip` maps case names to reasons), then deletes what they wrote. */
export async function fileChecks(backend, { skip = {} } = {}) {
  const root = `mayura-live-${Date.now().toString(36)}`;
  const store = createFileStore(backend, { maxFileBytes: 1_048_576 }).within(root);
  const results = [];
  for (const test of fileStoreConformance) {
    try { results.push([test.name, await test.run({ store, skip })]); } catch (error) { results.push([test.name, `FAILED: ${String(error.message).slice(0, 200)}`]); }
  }
  let removed = 0;
  try {
    let cursor;
    do {
      const page = await store.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const file of page.files) { await store.delete(file.key); removed++; }
      cursor = page.cursor;
    } while (cursor);
    const left = await store.list({ limit: 1 });
    results.push([`cleans up the ${removed} files the checks wrote`, left.files.length === 0 ? 'passed' : 'FAILED: files are left under the prefix']);
  } catch (error) { results.push(['cleans up', `FAILED: ${String(error.message).slice(0, 200)}`]); }
  return results;
}

export function report(results) {
  for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL'} ${name}${outcome.startsWith('FAILED') ? ` (${outcome})` : ''}`);
  process.exitCode = results.some(([, outcome]) => outcome.startsWith('FAILED')) ? 1 : 0;
}
