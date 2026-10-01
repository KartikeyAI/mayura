import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerignore, type DeployProject } from 'mayura/cli/deploy';

export interface AwsLambdaSettings {
  readonly region: string;
  /** The Lambda Node.js base image's major version: 22 by default. */
  readonly nodeVersion: 22 | 24;
  /** The instruction set the functions run on: `x86_64` (default) or `arm64`. */
  readonly architecture: 'x86_64' | 'arm64';
  /**
   * The compiled module that exports `handle(request)`, `advanceWorkflows()` and `migrate()`, relative to the project:
   * by default `mayura.js` next to the app module, such as `dist/src/mayura.js`.
   */
  readonly module: string;
}

const allowed = ['region', 'nodeVersion', 'architecture', 'module'];
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };

function settings(value: JsonValue | undefined, project: DeployProject): AwsLambdaSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.aws-lambda allows only ${allowed.join(', ')}.`);
  const region = raw['region']; const nodeVersion = raw['nodeVersion'] ?? 22; const architecture = raw['architecture'] ?? 'x86_64';
  const module = raw['module'] ?? `${project.app.slice(0, project.app.lastIndexOf('/') + 1)}mayura.js`;
  if (region !== undefined && (typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(region))) fail('targets.aws-lambda.region must be an AWS region, such as eu-west-1.');
  if (nodeVersion !== 22 && nodeVersion !== 24) fail('targets.aws-lambda.nodeVersion must be 22 or 24.');
  if (architecture !== 'x86_64' && architecture !== 'arm64') fail('targets.aws-lambda.architecture must be x86_64 or arm64.');
  if (typeof module !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}\.(?:js|mjs)$/u.test(module)) fail('targets.aws-lambda.module must be the compiled module\'s path inside the project, such as dist/src/mayura.js.');
  return { ...(region === undefined ? {} : { region: region as string }), nodeVersion, architecture, module: module as string } as AwsLambdaSettings;
}

/** The Lambda base image for both stages, so native modules are built for the Amazon Linux the functions run on. */
function lambdaDockerfile(lambda: AwsLambdaSettings): string {
  const base = `public.ecr.aws/lambda/nodejs:${lambda.nodeVersion}`;
  return `# The Lambda image: one build, three functions that differ only in their handler (set once per function).
FROM ${base} AS build
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM ${base}
COPY --from=build /build/package.json \${LAMBDA_TASK_ROOT}/
COPY --from=build /build/node_modules \${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /build/dist \${LAMBDA_TASK_ROOT}/dist
COPY deploy/aws-lambda/*.mjs \${LAMBDA_TASK_ROOT}/deploy/aws-lambda/
ENV NODE_ENV=production MAYURA_ENV=production
CMD ["deploy/aws-lambda/api.handler"]
`;
}

function handlers(lambda: AwsLambdaSettings): Record<string, string> {
  const from = `../../${lambda.module}`;
  return {
    'deploy/aws-lambda/api.mjs': `// The API function, behind a function URL: each event becomes a Request for Mayura's handle().
import { handle } from '${from}';

export async function handler(event) {
  const query = event.rawQueryString ? \`?\${event.rawQueryString}\` : '';
  const method = event.requestContext.http.method;
  const body = event.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const response = await handle(new Request(\`https://\${event.requestContext.domainName}\${event.rawPath}\${query}\`, { method, headers: event.headers, body }));
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}
`,
    'deploy/aws-lambda/workflows.mjs': `// The workflows function, invoked every minute by EventBridge Scheduler: advances what is due, then returns.
import { advanceWorkflows } from '${from}';

export const handler = () => advanceWorkflows();
`,
    'deploy/aws-lambda/migrate.mjs': `// The migration function, invoked by mayura deploy before the other functions are updated.
import { migrate } from '${from}';

export const handler = () => migrate();
`,
  };
}

/** Deploys to AWS Lambda from one container image: the migration function first, then the API and workflows functions. */
export const awsLambdaTarget = defineDeployTarget<AwsLambdaSettings>({
  id: 'aws-lambda', description: 'Deploy to AWS Lambda from one container image: migrate first, then the API and workflows functions.', tools: ['aws', 'docker'],
  settings,
  files: ({ settings: lambda }) => ({ '.dockerignore': dockerignore, 'deploy/aws-lambda/Dockerfile': lambdaDockerfile(lambda), ...handlers(lambda) }),
  plan: async ({ project, settings: lambda, release, readFile }) => {
    for (const path of ['deploy/aws-lambda/Dockerfile', 'deploy/aws-lambda/api.mjs', 'deploy/aws-lambda/workflows.mjs', 'deploy/aws-lambda/migrate.mjs']) await readFile(path);
    if (lambda.region === undefined) return fail('Set targets.aws-lambda.region in mayura.deploy.json.');
    if (release.image === undefined) return fail('Lambda runs an image: set "image" in mayura.deploy.json to an ECR repository.');
    const image = release.image; const at = ['--region', lambda.region];
    const platform = lambda.architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    // The invocation's result goes nowhere: the step checks only whether the function reported an error.
    const discard = (globalThis as { readonly process?: { readonly platform?: string } }).process?.platform === 'win32' ? 'NUL' : '/dev/null';
    const update = (role: string) => [
      { id: `update-${role}`, description: `Point ${project.name}-${role} at the new image`, tool: 'aws',
        args: ['lambda', 'update-function-code', ...at, '--function-name', `${project.name}-${role}`, '--image-uri', image, '--query', 'FunctionName', '--output', 'text'],
        output: { match: `${project.name}-${role}` } },
      { id: `wait-${role}`, description: `Wait until ${project.name}-${role} is updated`, tool: 'aws', args: ['lambda', 'wait', 'function-updated-v2', ...at, '--function-name', `${project.name}-${role}`] },
    ];
    return [
      { id: 'check-account', description: 'Check that the AWS CLI is signed in', tool: 'aws', args: ['sts', 'get-caller-identity', ...at, '--query', 'Account', '--output', 'text'], output: { match: '\\d{12}' } },
      // Lambda takes a single-platform image manifest, so no provenance attestation is attached.
      { id: 'build-image', description: `Build ${image}`, tool: 'docker', args: ['build', '--file', 'deploy/aws-lambda/Dockerfile', '--platform', platform, '--provenance=false', '--tag', image, '.'] },
      { id: 'push-image', description: `Push ${image}`, tool: 'docker', args: ['push', image] },
      ...update('migrate'),
      // A function error (the migration threw) prints its type here; success prints None.
      { id: 'migrate', description: 'Run the migration and check it succeeded', tool: 'aws',
        args: ['lambda', 'invoke', ...at, '--function-name', `${project.name}-migrate`, '--cli-read-timeout', '900', '--query', 'FunctionError', '--output', 'text', discard], output: { match: 'None' } },
      ...update('api'), ...update('workflows'),
    ];
  },
});

export default awsLambdaTarget;
