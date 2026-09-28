# Contributing to Mayura

Mayura is licensed under Apache-2.0. Contributions intentionally submitted for inclusion are accepted under the same license, as described by Section 5. Do not submit code you are not authorized to license.

## Local development

Use Node 24.14.1 and pnpm 10.17.1.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm check          # type-check and unit tests
pnpm example        # the first-agent example
pnpm docs:check     # documentation snippets and links
```

The repository is a pnpm workspace. Each part of Mayura is an internal package under `packages/<name>` (named `@mayura/<name>`, never published). `scripts/bundle-package.mjs` builds them into the one published package, `mayura`, where `@mayura/<name>` becomes `mayura/<name>`. Inside the repository, `packages/mayura` is a generated facade with the same entry points (`node scripts/workspace-facade.mjs`), so examples and starters import `mayura/...` exactly as users do. [AGENTS.md](AGENTS.md) lists the conventions and every check in one place.

Other checks: `pnpm test:consumer:optional` (clean browser, host and workflow installations), `pnpm test:bundle` (the published package, installed offline), `pnpm test:templates` and `pnpm test:starters` (every `mayura init` project, generated and tested). Run SQL integration tests with an isolated PostgreSQL database given by `MAYURA_TEST_POSTGRES_URL`. Test credentials must never be production credentials.

## Change requirements

1. Open an issue or proposal before substantial public API, persistence, authority or security-boundary work.
2. Define public contracts and security invariants before changing behavior.
3. Add regression coverage, including denied paths, cancellation, cost and failure recovery where relevant.
4. Keep public exports small and documented. No mandatory provider, native storage, server or UI dependency in the basic SDK. A change to the public API updates `compatibility/api-report.json` (`pnpm api:report`).
5. Run tests against emitted and packed artifacts; passing monorepo imports alone is insufficient.
6. Update the documentation in `docs/` (see below) and add a `CHANGELOG.md` entry under Unreleased.
7. Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …): releases are versioned from them. See [RELEASING.md](RELEASING.md).

Generated dependency/build files are produced by their tools. Source edits require review. Security-sensitive changes should be isolated and described without including live secrets or exploitable private data.

## Documentation

`docs/` is the public documentation: it becomes the documentation site and ships inside the npm package, so coding agents can read it offline. Each page starts with `title` and `description` frontmatter and is listed in `docs/README.md` and `llms.txt`. Import from `mayura` and `mayura/<subpath>` only. `pnpm docs:check` type-checks every TypeScript snippet against the built entry points (snippets may leave names such as `model` undeclared, but everything they import and call must be real), checks every link and heading, and checks that each `mayura <command>` exists.

## Checking model providers against live accounts

Provider adapters are tested in CI only with fake transports. `pnpm providers:live-check` runs the same adapters against **your** accounts, through the real runtime, and reports what passed. It sends paid requests and runs only when you set the variables below. It never looks for credentials, never reads files, and never prints a credential, a prompt or a provider error body. `pnpm providers:live-check --dry-run` runs the same checks against local fake transports, reads no environment variables and never reaches the network; CI runs it on every push.

Prices and cost caps are required; without them the harness refuses to run (exit code 2) and names the variables it needs. Set prices in micros (millionths of your billing currency) per million tokens.

| Variable | Required | Meaning |
|---|---|---|
| `MAYURA_LIVE_MAX_CALL_COST_MICROS` | yes | Per-call bound. Every adapter reserves it before each request. |
| `MAYURA_LIVE_MAX_TOTAL_COST_MICROS` | yes | Cap for the whole run. |
| `MAYURA_LIVE_MAX_OUTPUT_TOKENS` | no (1024) | `max_output_tokens` for every call. |
| `MAYURA_LIVE_TIMEOUT_MS` | no (60000) | Per-request timeout. |
| `MAYURA_LIVE_CHECKS` | no (all) | Comma-separated subset of `structured,tools,streaming,router_failover,router_streaming,vision,vision_tools`. |

A provider is selected only by its model variable; a credential on its own selects nothing. Once a provider is selected, its credential and both prices are required.

| Provider | Select with | Also required |
|---|---|---|
| OpenAI (`openAIResponses`) | `MAYURA_LIVE_OPENAI_MODEL` | `OPENAI_API_KEY`, `MAYURA_LIVE_OPENAI_INPUT_MICROS_PER_MILLION_TOKENS`, `MAYURA_LIVE_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS`; through a gateway also `MAYURA_LIVE_OPENAI_URL` (its endpoint, such as `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/responses`) and `MAYURA_LIVE_OPENAI_GATEWAY_TOKEN`, with which the key is optional |
| Anthropic (`anthropicMessages`) | `MAYURA_LIVE_ANTHROPIC_MODEL` | `ANTHROPIC_API_KEY`, `MAYURA_LIVE_ANTHROPIC_INPUT_MICROS_PER_MILLION_TOKENS`, `MAYURA_LIVE_ANTHROPIC_OUTPUT_MICROS_PER_MILLION_TOKENS`; through a gateway also `MAYURA_LIVE_ANTHROPIC_URL` (such as `…/<gateway>/anthropic/v1/messages`) and `MAYURA_LIVE_ANTHROPIC_GATEWAY_TOKEN` |
| Remote OpenAI-compatible (`openAICompatibleChat` with `remote`) | `MAYURA_LIVE_COMPATIBLE=<id>,<id>…` | per id: `MAYURA_LIVE_COMPATIBLE_<ID>_URL`, `_KEY`, `_MODEL`, optional `_AUTH` (`bearer` or `api-key`), and `_INPUT_MICROS_PER_MILLION_TOKENS` / `_OUTPUT_MICROS_PER_MILLION_TOKENS`; optional `_OUTPUT` (`json_object` for JSON-mode providers such as DeepSeek), `_STRICT_TOOLS` (`true`), `_TOKEN_LIMIT_FIELD` (`max_completion_tokens` for OpenAI's newer models), `_MEDIA` (the image types a model that can see takes, such as `image/png,image/jpeg`; without it the vision checks are skipped), `_BODY` (a JSON object of extra request fields) and `_GATEWAY_TOKEN` (Cloudflare AI Gateway's token, sent as `cf-aig-authorization`; with it, `_KEY` is optional) |

`<ID>` is the id in upper case with `-` replaced by `_` (`groq` becomes `GROQ`). Before sending anything, the harness computes a worst case of 13 per-call bounds per provider (`structured` 1, `tools` 3, `streaming` 1, `router_failover` 2, `router_streaming` 2, `vision` 1, `vision_tools` 3) and refuses to run when that exceeds the total cap. The router checks deliberately send the invalid key `mayura-live-check-deliberately-invalid-key` to the real endpoint, so expect one failed-authentication entry per router check in the provider's logs (for a gateway provider, the gateway token is the one made invalid).

For example, DeepSeek directly and through Cloudflare AI Gateway:

```sh
MAYURA_LIVE_COMPATIBLE=deepseek,cloudflare
MAYURA_LIVE_COMPATIBLE_DEEPSEEK_URL=https://api.deepseek.com/beta/chat/completions
MAYURA_LIVE_COMPATIBLE_DEEPSEEK_MODEL=deepseek-flash
MAYURA_LIVE_COMPATIBLE_DEEPSEEK_OUTPUT=json_object
MAYURA_LIVE_COMPATIBLE_DEEPSEEK_STRICT_TOOLS=true
MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions
MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_MODEL=deepseek/deepseek-flash
MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_OUTPUT=json_object
MAYURA_LIVE_COMPATIBLE_CLOUDFLARE_STRICT_TOOLS=true
# plus each id's _KEY or _GATEWAY_TOKEN, its two prices, and the caps
```

The `vision` checks draw a random six-digit number as a PNG and ask the model to read it: `vision` sends the image
with the input, `vision_tools` returns it from a screenshot tool. Five of the six digits must be read in place, so
the check proves that the image reached the model, not how well the model reads. They run for OpenAI and Anthropic,
and for a compatible provider with `_MEDIA`; for others they are skipped with the reason.

The JSON report lists each provider and check with `status` (`passed`, `failed` or `skipped`), duration, charge and model calls. Exit code 0 means every selected check passed, 1 that one failed or the total exceeded the cap, and 2 that the run was refused before anything was sent. A pass qualifies that account, model and endpoint today, not prices, model quality or future behaviour; run it again when you change models or upgrade Mayura.

## Governance and support

Governance and release ownership are defined in [GOVERNANCE.md](GOVERNANCE.md); support terms in [SUPPORT.md](SUPPORT.md); security reporting in [SECURITY.md](SECURITY.md). No external support SLA is promised for pre-releases.
