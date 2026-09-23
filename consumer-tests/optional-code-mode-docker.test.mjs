import { createDockerQuickJsSandboxAdapter } from '@mayura/adapter-code-docker';

let immutableImageRequired = false;
try {
  createDockerQuickJsSandboxAdapter({ dockerPath: 'docker', image: 'node:latest' });
} catch (error) {
  immutableImageRequired = error instanceof TypeError;
}
console.log(JSON.stringify({ status: immutableImageRequired ? 'passed' : 'failed', immutableImageRequired, noDockerDependency: true }));
