---
title: "Mayura philosophy"
description: "How Mayura handles model proposals, application authority, human decisions, and uncertain outcomes."
---

An agent can suggest a refund, draft a support reply, or prepare a release checklist. Once it can change application
state, someone needs to answer three questions. Who can authorize the action? What exactly will happen? What will we
know if the connection drops? Mayura is a TypeScript framework that makes those questions part of building an agent.

## The application grants authority

The model proposes a tool call. Mayura validates its input against the tool's schema and checks the runtime's grants
for that tool, its declared effect, and any required capabilities. The tool definition describes what the code can
do. Authority comes from explicit grants. Your server derives the principal and project from authenticated
identity, and your tool code enforces access to the records it handles. [Permissions](../concepts/permissions.md) ·
[Security](security.md)

## Work has limits

Give a run a finite budget for spending, time, steps, and calls before it starts. Paid model calls use configured
prices and an adapter's per-call ceiling, and child agents spend from the parent's budget. The application chooses
how much work it can afford for a request. [Costs and budgets](../concepts/costs-and-budgets.md)

## A person approves a concrete action

For an approval-required write, show the person the validated input for the exact tool and version, such as the
refund amount and its destination. Changing the input calls for a fresh decision. The permission checks still apply
when the tool runs. With durable storage, the workflow can persist the wait across a restart. A separate human-input
step can collect a typed answer when the workflow needs a fact or a choice. [Approvals and human input](../guides/approvals-and-human-input.md)

## Recovery starts with evidence

Say a refund request times out after dispatch. The provider may already have accepted it. Mayura reports
`outcome_unknown` and preserves the evidence it has for reconciliation. Check the external system before taking another
action, and use a stable idempotency key where the provider supports one. Durable workflows record progress so a
restart can recover from recorded state. [Outcomes](../concepts/outcomes.md) · [Durable workflows](../guides/durable-workflows.md)

## Sources can be inspected

Scoped retrieval checks what a principal and project can access and ties each citation to the exact passage of a
published revision. A reviewer can open that excerpt and judge whether it supports the answer. Mayura's published
qualification evidence names the model, store, corpus, and workload that were tested. [Retrieval](../guides/rag.md) ·
[RAG production qualification](../guides/rag-production.md)

## Start with the parts you need

Use a scripted model with one tool to test approval, refusal, and failure without a provider credential. Add
persistent storage, workflows, or React components as the job grows. Each runs through its own entry point or
integration, so you can start inside an application you already operate. [Testing](../guides/testing.md) ·
[Choose a starter](../guides/choosing-a-starter.md)

For a concrete first run, generate the [Next.js starter](../guides/nextjs.md#generate-and-run), review a proposed note,
and reopen the pending approval after a restart.
