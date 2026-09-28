---
title: "Develop with mayura dev"
description: "Build and run your project with mayura dev, load .env, and rebuild and restart on every saved change."
---

`mayura dev` is the development loop for a Mayura project. It builds the project, runs it, and on every saved change
rebuilds and restarts it. It also loads the project's `.env` file, so your model provider settings and other
configuration reach the running code without being exported in your shell.

Every starter runs it as `npm run dev`:

```bash
cd refunds
npm install
npm run dev
```

You can also run it directly from the project directory:

```bash
npx mayura dev
```

## What it runs

Run `mayura dev` in a directory with a `package.json`. It then:

1. **Builds** the project with its `build` script. With no `build` script but a `tsconfig.json`, it runs
   `tsc -p tsconfig.json`. With neither, it skips the build.
2. **Starts** the built project, choosing the first of these that applies:
   - the file you pass with `--entry <file>`;
   - `dist/src/dev.js`, if the project has one. The starters use this for a one-process local run with demo data;
   - otherwise, the application module (`--app <module>`, default `dist/src/app.js`) the way production runs it:
     `mayura migrate` once, then `mayura serve` and `mayura worker` as two separate processes.

If there is nothing to run, it says so and keeps watching. If `migrate` fails, it waits for your next change.

| Option | Meaning |
|---|---|
| `--entry <file>` | Run this built file with Node.js instead of looking for `dist/src/dev.js`. |
| `--app <module>` | The application module for migrate, serve and worker. Default `dist/src/app.js`. |
| `--no-watch` | Build and run once. The command ends when the project exits. |

Paths are relative to the project directory and point at built JavaScript, not TypeScript sources. For the
application module's contract, see [Serve, worker and migrate](run.md).

A project created from a template builds to `dist/index.js`, so run it with an entry:

```bash
npx mayura dev --entry dist/index.js
```

## .env loading

Before every build and every start, `mayura dev` reads `.env` from the project directory and passes its values to the
build and to the processes it starts. Editing `.env` takes effect on the next restart.

- Variables already set in your environment win over the file, as with `node --env-file`.
- It prints only the variable names it loaded, never their values:

  ```text
    loaded .env: ANTHROPIC_API_KEY, MAYURA_MODEL, MAYURA_MODEL_PROVIDER
  ```

- `node_modules/.bin` is added to `PATH`, so build scripts find `tsc` and other local tools.

`.env` is for local development. In production, set the same variables in the real environment of your server and
worker processes; `mayura serve` and `mayura worker` do not read `.env`.

## Watching and restarting

After the first start, `mayura dev` watches the project directory. When you save a file it waits 200 ms for more
changes, then rebuilds:

```text
~ src/workflow.ts changed
✔ built in 2.4s
● running dist/src/dev.js
```

- **If the build succeeds**, it stops the running processes and starts them again with the new build.
- **If the build fails**, it prints the last 40 lines of the build output and leaves the last good version running.
  Fix the error and save again.

It ignores changes the project makes to itself: `node_modules`, `dist`, `.data`, `.git`, `coverage`, SQLite
database files, `*.tsbuildinfo` and `*.log`. It reacts only when a file's modification time or size changes, or a
file appears or disappears, so merely reading files does not trigger a rebuild.

When it restarts, it asks each running process to stop and waits for it to exit. A process that has not exited
after 10 seconds is killed. On Windows the process is ended directly rather than interrupted.

## Stopping

Press Ctrl+C once to stop. `mayura dev` stops watching and waits for the running processes to shut down
gracefully; they receive the same interrupt from the terminal, so a worker can drain its in-flight work. Press Ctrl+C
again to force an immediate exit.

## Good to know

- If the platform cannot watch the directory recursively, `mayura dev` fails with `UNSUPPORTED_PROFILE`. Use
  `--no-watch`.
- The `serve` and `worker` processes it starts write their own lifecycle lines to the same terminal.
- `mayura dev` is for your machine. For production, run `mayura migrate`, `mayura serve` and `mayura worker`
  yourself; see [Serve, worker and migrate](run.md) and [Deployment](../guides/deployment.md).

## Related

- [Create a project](init.md)
- [Serve, worker and migrate](run.md)
- [CLI overview](overview.md)
- [Model providers](../guides/model-providers.md)
