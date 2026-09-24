import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('V21 public API classification', () => {
  it('classifies every supported workspace entry point and exposes no accidental stable surface', async () => {
    const root = resolve(import.meta.dirname, '..', '..', '..');
    const policy = JSON.parse(await readFile(resolve(root, 'compatibility', 'api-stability.json'), 'utf8')) as {
      format: number; release: string; stableEntryPoints: string[]; experimentalClassification: string; internalPackages: string[];
      trustedHostEntryPoints: string[];
    };
    expect(policy).toEqual({ format: 1, release: '0.1.0-dev.0', stableEntryPoints: [],
      experimentalClassification: 'all-exported-workspace-entrypoints', internalPackages: ['@mayura/consumer-tests'],
      trustedHostEntryPoints: ['@mayura/core/host', '@mayura/storage-sql/host', '@mayura/tools/host'] });
    const packages = resolve(root, 'packages');
    const classified: string[] = [];
    for (const directory of await readdir(packages)) {
      const manifest = JSON.parse(await readFile(resolve(packages, directory, 'package.json'), 'utf8')) as {
        name: string; version: string; private: boolean; exports?: Record<string, unknown>;
      };
      expect(manifest.version).toBe(policy.release);
      expect(manifest.private).toBe(true);
      if (policy.internalPackages.includes(manifest.name)) { expect(manifest.exports).toBeUndefined(); continue; }
      expect(Object.keys(manifest.exports ?? {}).length).toBeGreaterThan(0);
      for (const path of Object.keys(manifest.exports ?? {})) classified.push(path === '.' ? manifest.name : `${manifest.name}${path.slice(1)}`);
    }
    expect(classified).toEqual(expect.arrayContaining(policy.trustedHostEntryPoints));
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.length).toBeGreaterThan(20);
  });
});
