#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { offlineBackend, openRag } from './application.js';
import { connectHosted, readHostedSettings } from './hosted.js';

const help = 'Usage: rag demo | rag ingest --hosted <document-id> <markdown-file> | rag ask --hosted <question>';

async function main(args: string[]) {
  if (!args.length || args.length === 1 && args[0] === '--help') {
    console.log(help);
    return;
  }
  const [command, option, first, second] = args;
  if (command === 'demo' && args.length === 1) {
    const rag = await openRag(':memory:', { principalId: 'demo', projectId: 'handbook' }, offlineBackend());
    try {
      const text = await readFile(new URL('../../fixtures/on-call.md', import.meta.url), 'utf8');
      await rag.ingest('on-call', 'on-call.md', text);
      console.log(JSON.stringify(await rag.ask('When is the incident summary posted?'), null, 2));
    } finally {
      await rag.close();
    }
    return;
  }
  if (option !== '--hosted' || !first || !(command === 'ingest' && args.length === 4 && second || command === 'ask' && args.length === 3)) {
    throw new Error(help);
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const settings = readHostedSettings(process.env);
  await mkdir(dirname(settings.filename), { recursive: true, mode: 0o700 });
  // Reserve a private file before SQLite creates its catalog and workflow journal.
  const file = await open(settings.filename, 'a', 0o600);
  await file.close();
  const hosted = connectHosted(settings);
  try {
    const rag = await openRag(settings.filename, settings.scope, hosted.backend);
    try {
      const output = command === 'ingest'
        ? await rag.ingest(first, basename(second!), await readMarkdown(second!))
        : await rag.ask(first);
      console.log(JSON.stringify(output, null, 2));
    } finally {
      await rag.close();
    }
  } finally {
    hosted.close();
  }
}

/** Bound the local read before loading the source. Use fatal UTF-8 decoding to preserve exact evidence. */
async function readMarkdown(filename: string) {
  if (!['.md', '.markdown'].includes(extname(filename).toLowerCase())) {
    throw new Error('Supply a public Markdown file ending in .md or .markdown.');
  }
  const file = await open(filename, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('The Markdown source must be a regular file.');
    const limit = 128_000;
    const bytes = new Uint8Array(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('The Markdown source exceeds 128,000 bytes. Split it into smaller documents.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : 'RAG command failed.');
  process.exitCode = 1;
});
