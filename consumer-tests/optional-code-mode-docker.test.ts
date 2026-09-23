import { createDockerQuickJsSandboxAdapter } from '@mayura/adapter-code-docker';

const adapter = createDockerQuickJsSandboxAdapter({
  dockerPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  image: `sha256:${'a'.repeat(64)}`,
  provenance: `sha256:${'b'.repeat(64)}`,
});
void adapter.id;
// @ts-expect-error Mutable image tags are rejected at runtime, and a CLI path is mandatory at the type boundary.
createDockerQuickJsSandboxAdapter({ image: 'node:latest' });
