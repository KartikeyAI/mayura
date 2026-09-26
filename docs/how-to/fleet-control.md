# Operate a fleet-wide pause over HTTP

Fleet control is a separate least-authority adapter. Mutations require the dedicated `workflows:fleet` capability, which `workflows:control` does not imply; reading the hold needs only `workflows:read`. Grant `workflows:fleet` only to operator identities.

Bind the adapter to one [`createWorkflowFleetControl`](../specs/fleet-pause.md) per verified scope, with that scope's sweep targets:

```ts
const server = createAgentServer({
  // agents, authenticate, publicOrigin...
  workflowFleet: {
    inspect: ({ scope }) => fleets.for(scope).control.inspect(),
    hold: ({ scope }) => fleets.for(scope).control.hold(),
    release: ({ scope }) => fleets.for(scope).control.release(),
    sweep: async ({ scope, phase, cursor, limit }) => {
      const { control, targets } = fleets.for(scope);
      try {
        const page = phase === 'pause'
          ? await control.sweepPause(targets, { cursor: cursor as never, limit })
          : await control.sweepResume(targets, { cursor: cursor as never, limit });
        return { status: 'applied', sweep: page };
      } catch (error) {
        // Wrong hold state for the phase (pause needs held, resume needs released).
        if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'conflict' };
        throw error;
      }
    },
  },
});
```

The routes are:

| Route | Capability | Result |
|---|---|---|
| `GET /v1/workflow-fleet` | `workflows:read` | `{ fleet: { held, generation, changedAtMs } }` |
| `POST /v1/workflow-fleet/hold` with `{}` | `workflows:fleet` | hold state; the reply must show `held: true` |
| `POST /v1/workflow-fleet/release` with `{}` | `workflows:fleet` | hold state; the reply must show `held: false` |
| `POST /v1/workflow-fleet/sweeps/pause` or `/sweeps/resume` with `{ cursor, limit }` | `workflows:fleet` | `{ sweep: { outcomes, nextCursor } }`; wrong hold state is HTTP 409 |

`limit` is 1–128. `cursor` is `null` or the previous page's `nextCursor` object (at most 4 KiB), passed back unchanged. Outcomes carry only a target name, run ID and fixed outcome code, never workflow content. Every request is sent once; hold and release are idempotent, and re-sending a sweep page is safe because each run is inspected before it is paused or resumed.

From a browser or Node client:

```ts
await client.holdWorkflowFleet();
let cursor = null;
do { cursor = (await client.sweepWorkflowFleet('pause', { cursor })).nextCursor; } while (cursor);
// ...incident handling...
await client.releaseWorkflowFleet();
do { cursor = (await client.sweepWorkflowFleet('resume', { cursor })).nextCursor; } while (cursor);
```

From the CLI, `fleet-sweep` follows up to `--max-pages` pages (default 32). An unfinished sweep reports `status: "incomplete"` with its `nextCursor`; save that object to a file and continue with `--cursor-file`:

```text
mayura fleet-hold --url https://agent.example --token-stdin
mayura fleet-sweep --url https://agent.example --phase pause --max-pages 64 --token-stdin
mayura fleet-release --url https://agent.example --token-stdin
mayura fleet-sweep --url https://agent.example --phase resume --token-stdin
```
