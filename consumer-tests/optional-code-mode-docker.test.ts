import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, serializeDockerImagePromotion,
  type DockerImagePromotionProof, type DockerImagePromotionStatement } from '@mayura/adapter-code-docker';

const adapter = createDockerQuickJsSandboxAdapter({
  dockerPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  image: `sha256:${'a'.repeat(64)}`,
  provenance: `sha256:${'b'.repeat(64)}`,
});
void adapter.id;
declare const proof: DockerImagePromotionProof;
declare const statement: DockerImagePromotionStatement;
void serializeDockerImagePromotion(statement);
void createPromotedDockerQuickJsSandboxAdapter({ dockerPath: 'C:\\docker.exe', image: `sha256:${'a'.repeat(64)}`,
  provenance: `sha256:${'b'.repeat(64)}`, promotion: proof }).id;
// @ts-expect-error Mutable image tags are rejected at runtime, and a CLI path is mandatory at the type boundary.
createDockerQuickJsSandboxAdapter({ image: 'node:latest' });
