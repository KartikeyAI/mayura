---
title: "Introducing Mayura for agents that take action"
description: "Why we built an open-source TypeScript framework for agents that can propose a change, wait for approval, and show what happened."
date: 2026-11-27
tags: Mayura, TypeScript, approvals, durable workflows
---

A support agent recommends a $42 refund. Before it can issue that refund, your application has to answer a few
questions. Which order is it for? Who can authorize it? What happens if the payment provider receives the request
and the connection drops before the result comes back?

We built Mayura for that part of the job. Mayura is an open-source TypeScript framework for AI agents, typed tools,
and durable workflows. If you’re adding an agent to a support or operations app, you can define what it may do,
let people review sensitive changes, and keep a record of the work as it runs. The framework ships under
Apache-2.0. [Mayura on GitHub](https://github.com/KartikeyAI/mayura)

## Your application decides what the agent can do

A model can suggest calling a refund tool. Your server decides which caller the run acts for and which models,
tools, and effects it can use. Tool schemas check the arguments before execution and the result when it returns.
A run also has limits on work such as steps and tool calls. For paid model use, you can configure a budget and
bound what each call may cost. [Permissions](../../../docs/concepts/permissions.md) ·
[Costs and budgets](../../../docs/concepts/costs-and-budgets.md)

Those controls matter most when a model takes in data you don’t control. A support ticket can contain persuasive
instructions. Your app still derives the caller’s authority from verified identity and its own rules. When a
response uses retrieved evidence, you can give people the exact passage it cites so they can check the claim in
context. [Security model](../../../docs/project/security.md) ·
[Retrieval and citations](../../../docs/guides/rag.md)

## People can review a specific change

An approval can be as specific as “refund $42 on this order.” Mayura ties that decision to the proposed call and
its arguments. The React workspace can show what will change before a person decides. With persistent storage, a
durable workflow can save the point where it needs a decision and resume after a restart.
[Approvals and human input](../../../docs/guides/approvals-and-human-input.md) ·
[Agent Workspace](../guides/agent-workspace.md)

Some failures need a human or another system to resolve them. If a write may have happened and the result is
missing, Mayura can surface an unknown outcome so you can check the external system before attempting another
write. A provider’s idempotency support or a way to look up the original operation is still important. That
tradeoff is central to the design. [Outcomes](../../../docs/concepts/outcomes.md) ·
[Mayura’s philosophy](../../../docs/project/philosophy.md)

## Where Mayura goes from here

We’re prioritizing broader qualification of real applications. That includes testing more retrieval configurations,
checking keyboard and screen-reader behavior in the React workspace, and verifying reconnection with more AG-UI
clients. We also plan to exercise more providers and deployment profiles. Today the production retrieval evidence
covers a registered Modal and Pinecone configuration on Loki software-operations documentation. We’ll document new
configurations alongside their measured results as qualification expands. [Roadmap](https://mayurajs.com/roadmap/) ·
[Retrieval qualification matrix](../../../docs/guides/rag-production.md)

## Try an approval

Open the workspace demo, choose **Save the release checklist**, and review the proposed file before you approve
or decline. It runs in the browser with sample data. [Try the approval demo](https://mayurajs.com/#approval-demo)

For a local run, use the Next.js starter. Approve one note, reject another, then restart the app while a third is
waiting. You can recover the pending approval from SQLite without submitting the note again. The starter uses a
scripted model and needs no model API key. If the flow fits your app, replace the sample tool with one action you
already own. [Run your first approval in Next.js](../guides/first-approval.md)

What’s one action you’d let an agent prepare today if a person could review the exact change first? Tell us what
you’re building and where the starter gets in your way. [Share feedback on GitHub](https://github.com/KartikeyAI/mayura/issues)
