---
title: "Copy-in UI components"
description: "Install versioned React source components with reviewed file plans, explicit controls and caller-owned Mayura stores."
---

The `mayura add ui` registry copies React source and shared CSS into `src/components/mayura/`. Your application owns
that source. Existing [React runtime components](react.md) remain available in 1.x; hooks/controllers still enforce
bounded subscription and command behavior. You can also install the standalone [@mayurajs/ui library](../integrations/ui.md).

## Choose and copy

```bash
mayura add ui --list
mayura add ui chat thread-history approval thread-list run-status --directory ./my-app
mayura add ui chat thread-history approval thread-list run-status --directory ./my-app --apply
```

The first command lists bundled registry entries. The second returns a content-bound file plan without writing;
`--apply` writes that exact fresh plan. Existing files require `--confirm <displayed-plan-digest>`. Review replacement
diffs before copying that digest. Stale files, symlink targets, unknown/duplicate components and incompatible installed
Mayura versions are refused. The CLI does not install dependencies, modify package.json, download registry code or
run installation hooks.

Install React and Mayura first and configure TypeScript JSX (`react-jsx`) and CSS imports in your application.
The CLI checks the target project's installed Mayura manifest. The copy-in components support stable Mayura
releases from 1.2 through 1.x and compatible release candidates.
Registry entries include source version, supported Mayura range, dependencies and all copied files. Shared `ui.css`
uses overridable `--ui-*` variables and no external stylesheet/font service.

## Components

| Name | Host binding |
| --- | --- |
| `chat` | `HeadlessRunStore`, explicit async send handler; one in-flight send |
| `thread-history` | Caller-owned thread store and explicit pagination handlers |
| `approval` | Digest-bound approval controller and caller-supplied clock |
| `thread-list` | Caller-owned scoped thread-index store and selection handler |
| `run-status` | Authenticated run store, including actual budget/status |
| `workflow-progress` | Released workflow graph projection |
| `tool-call` | Bounded released text input/result and status |
| `citations` | Released source titles and optional safe HTTPS links |
| `browser-view` | Released screenshot restricted to the host's allowed HTTPS origin |
| `sandbox-terminal` | Bounded plain-text sandbox output; no shell/ANSI/HTML execution |
| `voice` | Explicit microphone click, bounded recording, host-owned delivery callback |

Thread history and approval copy their rendering implementation, with subscriptions through public React hooks.
The other connected components compose public 1.x hooks/components. No source component starts an agent, approves
an action, fetches media or executes a tool merely by mounting. The voice control requests microphone permission only
on a click, stops tracks on completion/unmount, and bounds recordings to 30 seconds and 4 MB. Its host callback owns
transcription, permissions and cost; there is no automatic model call.

## Bind application state

Create clients and headless stores once in your application/session owner; supply them as props. Refresh pages or
observe runs explicitly from application event handlers, and dispose stores when the owning session ends. Approval
controls require an exact controller binding and current clock. Failed/uncertain commands require inspection;
there is no optimistic write replay. See [threads](threads.md), [React bindings](react.md) and
[approvals](approvals-and-human-input.md).

The website's `/ui/copy-in/` gallery provides a live preview and source view for each CLI registry entry. Connected controls use
local fixture state without service credentials. Display components and the voice control render copied source;
no preview can approve a real operation or start paid inference. Registry tests, framework starter checks and the website build/link checks passed locally. Rendered browser interaction, visual and accessibility checks remain outstanding; see [release validation status](release-readiness.md).

## shadcn registry

The standalone [Mayura UI library](../integrations/ui.md) also has a shadcn registry. In a React 19 app with
Tailwind v4 and shadcn initialized, add the Mayura namespace to the `registries` object in `components.json`.

```json
{
  "registries": {
    "@mayura": "https://mayurajs.com/r/{name}.json"
  }
}
```

Install the full library or choose individual components.

```sh
pnpm dlx shadcn@latest add @mayura/ui
pnpm dlx shadcn@latest add @mayura/chat-workspace
pnpm dlx shadcn@latest add @mayura/composer @mayura/thread-history
```

The other entries are `reply`, `reply-cards`, `artifacts`, `approvals`, `ag-ui`, and `run-activity`. Each entry copies its React
source with inline Tailwind utilities under `mayura` in your configured UI directory. The command merges the shared
theme into your configured app stylesheet. Wrap the copied components in `UiRoot`. With the full kit and the default
Vite aliases, use these imports.

```js
import { Composer, UiRoot } from '@/components/ui/mayura';
```

Individual entries use direct imports such as `@/components/ui/mayura/composer` and
`@/components/ui/mayura/ui-root`. The shadcn source runs without Mayura. Supply your own handlers or connect
the AG-UI hook to a compatible transport.

## Programmatic plans

```ts
import { planUiComponents, applyUiPlan } from 'mayura/cli';

declare const absoluteProjectDirectory: string;
const plan = await planUiComponents(['chat', 'approval'], absoluteProjectDirectory);
// Show plan.changes and collect a review decision before replacing existing source.
// With no replacements, an explicit call to applyUiPlan(plan) writes the genuine plan.
void applyUiPlan;
void plan;
```

`uiComponents`, `planUiComponents` and `applyUiPlan` are Node-only CLI APIs. Tests for version denial, overwrite review,
source bounds, stale plans and one-shot application passed in the local unit suite.
