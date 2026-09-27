import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public API classification', () => {
  it('classifies every workspace entry point exactly once as stable or trusted-host, with a reviewed API report', async () => {
    const root = resolve(import.meta.dirname, '..', '..', '..');
    const policy = JSON.parse(await readFile(resolve(root, 'compatibility', 'api-stability.json'), 'utf8')) as {
      format: number; release: string; targetRelease: string; stableEntryPoints: string[]; trustedHostEntryPoints: string[];
      experimentalEntryPoints: string[]; internalPackages: string[]; apiReport: string;
    };
    expect(policy).toMatchObject({ format: 2, targetRelease: '1.0.0', experimentalEntryPoints: [], internalPackages: ['@mayura/consumer-tests', '@mayura/inspector-ui', 'mayura'],
      trustedHostEntryPoints: ['@mayura/core/host', '@mayura/storage-sql/host', '@mayura/tools/host'], apiReport: 'compatibility/api-report.json' });
    const packages = resolve(root, 'packages');
    const classified: string[] = []; let facade: Record<string, unknown> | undefined;
    for (const directory of await readdir(packages)) {
      const manifest = JSON.parse(await readFile(resolve(packages, directory, 'package.json'), 'utf8')) as {
        name: string; version: string; private: boolean; exports?: Record<string, unknown>;
      };
      expect(manifest.version).toBe(policy.release);
      expect(manifest.private).toBe(true);
      // The workspace `mayura` facade mirrors the published package's entry points (checked below); others export nothing.
      if (manifest.name === 'mayura') { facade = manifest.exports; continue; }
      if (policy.internalPackages.includes(manifest.name)) { expect(manifest.exports).toBeUndefined(); continue; }
      expect(Object.keys(manifest.exports ?? {}).length).toBeGreaterThan(0);
      for (const path of Object.keys(manifest.exports ?? {})) classified.push(path === '.' ? manifest.name : `${manifest.name}${path.slice(1)}`);
    }
    const tiers = [...policy.stableEntryPoints, ...policy.trustedHostEntryPoints, ...policy.experimentalEntryPoints];
    expect(new Set(tiers).size).toBe(tiers.length);
    expect([...classified].sort()).toEqual([...tiers].sort());
    const report = JSON.parse(await readFile(resolve(root, policy.apiReport), 'utf8')) as { entryPoints: Record<string, Record<string, unknown>> };
    expect(Object.keys(report.entryPoints).sort()).toEqual([...classified].sort());
    // Every classified entry point is one subpath of `mayura` (and `mayura` itself is the SDK), and nothing else is.
    const published = classified.map(entry => `./${entry.slice('@mayura/'.length)}`);
    expect(Object.keys(facade ?? {}).sort()).toEqual(['.', ...published].sort());
  });
});
