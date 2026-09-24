import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..', '..');

describe('V22 open-source release trust', () => {
  it('binds the source tree to complete Apache-2.0 legal and release governance', async () => {
    const [license, notice, governance, support, security, contributing, releasing] = await Promise.all(
      ['LICENSE', 'NOTICE', 'GOVERNANCE.md', 'SUPPORT.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/releasing.md']
        .map(path => readFile(resolve(root, path), 'utf8')),
    );
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
    expect(notice).toContain('Copyright 2026 The Mayura Authors');
    expect(governance).toContain('release owner');
    expect(support).toContain('best-effort community support only');
    expect(security).toContain('private vulnerability-reporting facility');
    expect(contributing).toContain('Apache-2.0');
    expect(releasing).toContain('pnpm release:artifacts');
  });

  it('keeps source packages non-publishable while controlled release staging owns public metadata', async () => {
    const workspace = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { private: boolean; license: string; scripts: Record<string, string> };
    expect(workspace).toMatchObject({ private: true, license: 'Apache-2.0' });
    expect(workspace.scripts['release:artifacts']).toBe('node scripts/release-artifact-check.mjs');
    for (const directory of await readdir(resolve(root, 'packages'))) {
      const manifest = JSON.parse(await readFile(resolve(root, 'packages', directory, 'package.json'), 'utf8')) as { private: boolean };
      expect(manifest.private).toBe(true);
    }
  });
});
