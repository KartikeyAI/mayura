import { MayuraError, type Authorizer, type AuthorizationDecision, type Scope } from '@mayura/core';

/** Host-owned policy adapter. No policy object or authorization result is durable execution evidence. */
export function workflowAuthorization(authorization: Authorizer | undefined, suppliedScope: Scope, parentExecution?: (runId: string, signal: AbortSignal) => Promise<void>) {
  const scope = Object.freeze({ principalId: suppliedScope.principalId, projectId: suppliedScope.projectId });
  const stop = new AbortController();
  let evaluate: Authorizer['authorize'] | undefined;
  try {
    if (authorization !== undefined) {
      if (typeof authorization.authorize !== 'function') throw new Error();
      evaluate = authorization.authorize.bind(authorization);
    }
  } catch { throw new MayuraError('INVALID_CONFIG', 'A workflow authorizer must provide the core authorization contract.'); }

  const decide = async (kind: 'workflow' | 'run' | 'tool', id: string, action: string, signal = stop.signal): Promise<AuthorizationDecision | undefined> => {
    if (!evaluate) return undefined;
    if (kind === 'run' && action === 'execute') await parentExecution?.(id, signal);
    const decision = await evaluate(scope, action, { kind, id, scope, ...(kind === 'run' ? { ownerId: scope.principalId } : {}) }, { signal });
    if (!decision || (decision.effect !== 'allow' && decision.effect !== 'deny')) {
      throw new MayuraError('PERMISSION_DENIED', 'Workflow operation is not authorized.');
    }
    return decision;
  };
  const require = async (kind: 'workflow' | 'run' | 'tool', id: string, action: string, signal?: AbortSignal): Promise<void> => {
    try {
      const decision = await decide(kind, id, action, signal);
      if (decision !== undefined && decision.effect !== 'allow') throw new Error();
    } catch { throw new MayuraError('PERMISSION_DENIED', 'Workflow operation is not authorized.'); }
  };
  const execute = async (definition: string, id: string, signal?: AbortSignal): Promise<void> => {
    await require('workflow', definition, 'execute', signal);
    await require('run', id, 'execute', signal);
  };
  return Object.freeze({
    require, execute,
    /** Broker admission and disclosure recheck the owning workflow as well as the tool itself. */
    tool(definition: string, id: string, parent?: (signal?: AbortSignal) => Promise<void>): Authorizer | undefined {
      if (!authorization || !evaluate) return undefined;
      return Object.freeze({ ...authorization, authorize: async (...args: Parameters<Authorizer['authorize']>) => {
        const signal = args[3]?.signal;
        await parent?.(signal);
        const workflow = await decide('workflow', definition, 'execute', signal);
        if (workflow?.effect === 'deny') return workflow;
        const run = await decide('run', id, 'execute', signal);
        if (run?.effect === 'deny') return run;
        return evaluate!(...args);
      } });
    },
    /** Omit an absent authorizer when forwarding through exact optional-property boundaries. */
    toolContext(definition: string, id: string, parent?: (signal?: AbortSignal) => Promise<void>): { readonly authorization?: Authorizer } {
      const authorization = this.tool(definition, id, parent);
      return authorization === undefined ? {} : { authorization };
    },
    /** Cancel this engine's policy waits without closing the host's shared authorizer or audit sink. */
    close: () => stop.abort(),
  });
}
