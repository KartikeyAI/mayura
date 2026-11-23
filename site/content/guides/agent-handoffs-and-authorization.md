---
title: "Hand a conversation to a specialist without handing over every permission"
description: "Design support-to-billing handoffs with one conversation, a continuing budget and separately declared target authority."
date: 2026-10-23
tags: handoffs, authorization, agents, budgets
---

A support agent may need a billing specialist. Sharing context is useful; sharing every support permission is not
automatically appropriate. Mayura 1.2 handoffs preserve the run and conversation while switching to the host's
declared target permissions, tools, model and hooks.

## Decide whether to transfer or delegate

A handoff transfers control: the source does not get another model turn. A child agent runs separately and returns
a result to its parent. Choose a handoff for a continuing conversation owned by the specialist; choose a child when
the original agent needs a bounded answer and should continue coordinating.

| Decision | Handoff | Child agent |
| --- | --- | --- |
| Conversation owner | Changes to the target | Parent continues |
| Run identity | Continues | Child has its own run |
| Spending | Continuing run budget and counters | Bounded shared spending through delegation |
| Authority | Host-declared target permissions | Restricted delegated permissions |

## Declare the edge before the model sees it

Register the target in the source definition's `handoffs` entries. Each edge names the agent and its grant list.
The source needs the target's `agent:<id>` grant. A virtual handoff tool proposes the target input; it cannot name
an undeclared agent or invent permissions. Keep `maxHandoffs`, call/step ceilings and time limits finite.

Use the complete offline example in [Agent handoffs](../../../docs/guides/agent-handoffs.md) to try a support-to-billing
transfer. The V1.2 profile supports buffered text-only, non-speculative root runs; do not assume every streaming,
branching or media combination is covered.

## Check resource access separately

Tool grants determine which capabilities a run can attempt. Resource policies determine whether this verified
principal may perform that action on this record. Configure [built-in RBAC](../../../docs/guides/authorization.md)
or an optional OpenFGA, Cedar, Permit.io, Oso or HTTP authorizer on the host. Neither conversation text nor a handoff
proposal is an authorization decision.

Policy failure, cancellation or timeout must not turn into permission to execute. Audit events and OpenTelemetry
integration record bounded decision metadata; they do not require exporting prompts or document bodies.

## Approvals remain exact

An approval checkpoint pins the active target policy and pending call. Resuming continues that target with the
saved budget and conversation. A changed definition or uncertain write calls for inspection, not replaying prior
model calls or tool effects.

Keep [approval controls](persistent-chat-approvals.md) tied to the displayed call and evaluate external policy
services against real deployed policies before claiming interoperability. Offline adapter conformance is not that
deployment check; see [release limitations](../../../docs/guides/release-readiness.md).
