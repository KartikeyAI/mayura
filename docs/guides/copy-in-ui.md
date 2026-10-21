---
title: "Copy-in UI components"
description: "Install versioned React source components with reviewed file plans, explicit controls and caller-owned Mayura stores."
---

The `mayura add ui` registry copies React source and shared CSS into `src/components/mayura/`. Your application owns
that source. Existing [React runtime components](react.md) remain available in 1.x; hooks/controllers still enforce
bounded subscription and command behavior. The registry introduces no new runtime UI package.

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
The initial registry requires Mayura 1.2.x or a compatible 1.2 release candidate, and refuses 1.1 installations. During
release-1.2 development the repository manifest is still 1.1; installation becomes usable against an installed 1.2
build after release versioning. The CLI reads the target's installed Mayura manifest, not a claimed model version.
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

The website's `/ui` gallery provides a live preview and source view for each registry entry. Connected controls use
local fixture state without service credentials. Display components and the voice control render copied source;
no preview can approve a real operation or start paid inference. Registry tests, framework starter checks and the website build/link checks passed locally. Rendered browser interaction, visual and accessibility checks remain outstanding; see [release validation status](release-readiness.md).

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
