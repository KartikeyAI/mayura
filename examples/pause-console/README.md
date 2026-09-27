# Pause console (live UI example)

A local operator console for durable pause and fleet control. It runs a real SQLite lifecycle fleet driven by a lifecycle host, a durable fleet hold, and an authenticated loopback API; the page is built with Vite from `mayura/client`, `mayura/client/workflows` and the `mayura/client-react/components` pause controls.

```sh
pnpm build
node examples/pause-console/server.mjs
```

Open the printed URL. Three runs each perform a slow draft effect and then wait for their publish timer (20 s, 90 s and 10 min). You can:

- pause and resume individual runs (a run whose effect is in flight reports a conflict instead of pausing);
- hold the fleet, which pauses every discoverable run through a sweep and stops the host from driving runs, then release it, which resumes only the runs the fleet paused.

`MAYURA_CONSOLE_EFFECT_MS` changes the draft duration (default 4000; use 30000 to exercise the in-flight conflict) and `MAYURA_CONSOLE_PORT` pins the page port. Stop with Ctrl+C: the host drains within 10 s and temporary files are removed.

Demo boundaries: the API is loopback-only, the page receives a short-lived local token from `/config.json`, and the command journal is in memory. A production adapter authenticates with your identity provider and journals command IDs durably with each mutation.
