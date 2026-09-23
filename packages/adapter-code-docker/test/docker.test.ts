import { describe, expect, it } from 'vitest';
import { createDockerQuickJsSandboxAdapter } from '../src/index.js';

describe('Docker QuickJS adapter configuration', () => {
  it('requires an absolute CLI and immutable image content ID', () => {
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image: `sha256:${'a'.repeat(64)}` })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: 'node:latest' })).toThrow(TypeError);
    expect(() => createDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: `sha256:${'A'.repeat(64)}` })).toThrow(TypeError);
  });
});
