# Live checks

Each script here checks one integration package against a real account. Each script is named after its package, so
`auth-okta.mjs` checks `@mayurajs/auth-okta`. CI never runs them: they need your credentials, and some spend money.
Model providers have their own harness, `pnpm providers:live-check` (see [CONTRIBUTING.md](../../CONTRIBUTING.md)).

```sh
cp .env.example .env.live        # then fill in the accounts you have; .env.live is git-ignored
pnpm build
node --env-file=.env.live scripts/live/auth-okta.mjs
```

- **Variables.** Each script's header says which variables it needs. `.env.example` lists every one by platform,
  with where to get it. An empty variable counts as unset. A script missing a variable it requires says which, and
  exits with code 2 without sending anything. Optional variables only add checks.
- **Results.** Each check prints `PASS` or `FAIL` and the script exits 0 only when every check passed. Scripts print
  outcomes and counts only, never a credential, a token or a provider's reply body.
- **What they create.** Sandbox, browser and API key scripts create real sessions, sandboxes or keys and remove them
  when they finish. An interrupted run can leave one behind until it expires. `sandbox-apple-container.mjs` keeps
  its host-only network and prints the command that deletes it. Sign-in scripts only read the provider's public keys
  and verify tokens. Use test accounts.
- **Paths.** Scripts import the built packages relative to their own location, so run `pnpm build` first. They can
  be run from any directory.
