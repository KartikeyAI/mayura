import { MayuraError, type JsonObject, type JsonValue } from 'mayura';
import { defineDeployTarget, dockerfile, dockerignore, imageSteps, type DeployStep } from 'mayura/cli/deploy';

/** Where a release's image is built: by Azure Container Registry (`az acr build`), or by your local Docker and pushed. */
export type AzureBuild = 'acr' | 'local';

export interface AzureContainerAppsSettings {
  /** The resource group of the container apps and the job; a release needs it. */
  readonly resourceGroup?: string;
  /** The subscription to use (`--subscription`); the CLI's current one when absent. */
  readonly subscription?: string;
  readonly build: AzureBuild;
  /** The Azure Container Registry (its name, not its host) for `acr` builds; taken from an `<name>.azurecr.io` image by default. */
  readonly registry?: string;
  /** How long a release waits for the migration, and for each new revision, in seconds (1800 and 600 by default). */
  readonly migrationTimeoutSeconds: number;
  readonly revisionTimeoutSeconds: number;
}

const allowed = ['resourceGroup', 'subscription', 'build', 'registry', 'migrationTimeoutSeconds', 'revisionTimeoutSeconds'];
const fail = (message: string): never => { throw new MayuraError('INVALID_CONFIG', message); };
const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function settings(value: JsonValue | undefined): AzureContainerAppsSettings {
  const raw = (value ?? {}) as JsonObject;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail(`targets.azure allows only ${allowed.join(', ')}.`);
  const group = raw['resourceGroup']; const subscription = raw['subscription']; const build = raw['build'] ?? 'acr'; const registry = raw['registry'];
  // Azure also allows parentheses in group names; cmd.exe runs az on Windows and would interpret them.
  if (group !== undefined && (typeof group !== 'string' || !/^[A-Za-z0-9_.-]{1,90}$/u.test(group) || group.endsWith('.'))) fail('targets.azure.resourceGroup must be a resource group name of letters, digits, "_", "-" and ".".');
  if (subscription !== undefined && (typeof subscription !== 'string' || !new RegExp(`^${guid}$`, 'u').test(subscription))) fail('targets.azure.subscription must be a subscription id.');
  if (build !== 'acr' && build !== 'local') fail('targets.azure.build must be acr or local.');
  if (registry !== undefined && (typeof registry !== 'string' || !/^[A-Za-z0-9]{5,50}$/u.test(registry))) fail('targets.azure.registry must be an Azure Container Registry name.');
  const seconds = (name: string, fallback: number): number => {
    const item = raw[name] ?? fallback;
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 60 || item > 3_600) fail(`targets.azure.${name} must be from 60 to 3600 seconds.`);
    return item as number;
  };
  return { ...(group === undefined ? {} : { resourceGroup: group as string }), ...(subscription === undefined ? {} : { subscription: subscription as string }), build,
    ...(registry === undefined ? {} : { registry: registry as string }), migrationTimeoutSeconds: seconds('migrationTimeoutSeconds', 1_800), revisionTimeoutSeconds: seconds('revisionTimeoutSeconds', 600) } as AzureContainerAppsSettings;
}

/** Deploys to Azure Container Apps with az: a migration job run to completion, then the server and worker apps. */
export const azureContainerAppsTarget = defineDeployTarget<AzureContainerAppsSettings>({
  id: 'azure', description: 'Deploy to Azure Container Apps with az: a migration job run to completion, then the server and worker apps.', tools: ['az', 'docker'],
  settings,
  files: ({ project }) => ({ Dockerfile: dockerfile(project), '.dockerignore': dockerignore }),
  plan: async ({ project, settings: azure, release, readFile }) => {
    await readFile('Dockerfile');
    if (azure.resourceGroup === undefined) return fail('Set targets.azure.resourceGroup in mayura.deploy.json.');
    if (release.image === undefined) return fail('Container Apps run an image: set "image" in mayura.deploy.json, such as acme.azurecr.io/refunds.');
    const image = release.image;
    const account = azure.subscription === undefined ? [] : ['--subscription', azure.subscription];
    const group = ['--resource-group', azure.resourceGroup, ...account];
    const text = ['--output', 'tsv'];
    let build: DeployStep[];
    if (azure.build === 'acr') {
      const host = image.slice(0, image.indexOf('/'));
      const registry = azure.registry ?? (/^[a-z0-9]{5,50}\.azurecr\.io$/u.test(host) ? host.slice(0, host.indexOf('.')) : undefined);
      if (registry === undefined) return fail('An acr build needs targets.azure.registry, or an image in <registry>.azurecr.io.');
      build = [{ id: 'build-image', description: `Build ${image} in ${registry}`, tool: 'az', args: ['acr', 'build', '--registry', registry, '--image', image.slice(image.indexOf('/') + 1), ...account, '.'] }];
    } else build = imageSteps(release, 'azure');
    const poll = (seconds: number) => ({ attempts: Math.ceil(seconds / 5), intervalSeconds: 5 });
    const app = (role: 'server' | 'worker'): DeployStep[] => [
      { id: `update-${role}`, description: `Update ${project.name}-${role} to the new image`, tool: 'az',
        args: ['containerapp', 'update', '--name', `${project.name}-${role}`, ...group, '--image', image, '--query', 'properties.latestRevisionName', ...text],
        output: { match: `${project.name}-${role}--[a-z0-9-]+`, as: `${role}Revision` } },
      // A new revision activates while its probes pass; Failed or Degraded stops the release.
      { id: `${role}-ready`, description: `Wait until the new ${role} revision is running`, tool: 'az',
        args: ['containerapp', 'revision', 'show', '--name', `${project.name}-${role}`, ...group, '--revision', `{{${role}Revision}}`, '--query', 'properties.runningState', ...text],
        output: { match: 'Running|RunningAtMaxScale', retry: { while: 'Activating|Processing|Provisioning', ...poll(azure.revisionTimeoutSeconds) } } },
    ];
    return [
      { id: 'check-account', description: 'Check that az is signed in', tool: 'az', args: ['account', 'show', ...account, '--query', 'id', ...text], output: { match: guid } },
      ...build,
      { id: 'migrate-image', description: `Point ${project.name}-migrate at the new image`, tool: 'az',
        args: ['containerapp', 'job', 'update', '--name', `${project.name}-migrate`, ...group, '--image', image, '--query', 'name', ...text], output: { match: `${project.name}-migrate` } },
      { id: 'migrate', description: 'Start the migration', tool: 'az',
        args: ['containerapp', 'job', 'start', '--name', `${project.name}-migrate`, ...group, '--query', 'name', ...text], output: { match: `${project.name}-migrate-[a-z0-9]+`, as: 'execution' } },
      { id: 'migrate-wait', description: 'Wait for the migration to succeed', tool: 'az',
        args: ['containerapp', 'job', 'execution', 'show', '--name', `${project.name}-migrate`, ...group, '--job-execution-name', '{{execution}}', '--query', 'properties.status', ...text],
        output: { match: 'Succeeded', retry: { while: 'Running|Processing|Pending', ...poll(azure.migrationTimeoutSeconds) } } },
      ...app('server'), ...app('worker'),
    ];
  },
});

export default azureContainerAppsTarget;
