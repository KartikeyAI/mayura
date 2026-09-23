import { describe, expect, it } from 'vitest';
import { createDockerQuickJsSandboxAdapter } from '../src/index.js';

describe('Docker QuickJS adapter configuration', () => {
  it('requires an absolute CLI and immutable image content ID', () => {
    const provenance = `sha256:${'b'.repeat(64)}`;
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image: `sha256:${'a'.repeat(64)}`, provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: 'node:latest', provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: `sha256:${'A'.repeat(64)}`, provenance })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: `sha256:${'a'.repeat(64)}`, provenance: 'sha256:bad' })).toThrow(TypeError);
  });
});
