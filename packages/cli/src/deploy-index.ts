// mayura/cli/deploy: deploy a Mayura app with the tools you already use. Platform packages (@mayurajs/deploy-*) build
// their targets with defineDeployTarget and the container helpers here.
export {
  applyDeployFiles, defineDeployTarget, listDeployTargets, planDeploy, planDeployFiles, readDeployConfig, resolveDeployTarget, runDeployPlan, spawnDeployStep,
  type DeployConfig, type DeployFilesContext, type DeployFilesPlan, type DeployPlan, type DeployPlanContext, type DeployProject, type DeployRelease,
  type DeployResult, type DeployRunner, type DeployStep, type DeployStepResult, type DeployTarget,
} from './deploy.js';
export {
  IMAGE_PLACEHOLDER, RELEASE_PLACEHOLDER, builtInDeployTargets, composeTarget, dockerTarget, dockerfile, dockerignore, imageSteps, kubernetesTarget, releaseSlug,
} from './deploy-targets.js';
export type { FileChange as DeployFileChange } from './files.js';
