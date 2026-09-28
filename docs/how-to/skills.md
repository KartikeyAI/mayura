# Give an agent skills

A **skill** is a folder of instructions (and optional reference files) for one kind of task: filling a form, writing
release notes, deciding a refund under a policy. An agent sees only each skill's name and one-line description. When a
task matches, it loads the skill's full instructions with a tool and reads its files on demand, so dozens of skills
cost almost nothing until one is used. Folders follow the open `SKILL.md` format, so skills written for other tools
work here too.

## Write a skill

```text
skills/
  refund-policy/
    SKILL.md
    references/policy.md
```

```markdown
---
name: refund-policy
description: Decide refunds under the store policy. Use when a customer asks for their money back.
---
# Refund policy

1. Read references/policy.md.
2. Refunds up to 50 EUR are automatic; above that, ask a person to approve.
```

`name` must be lower-case letters, digits and single hyphens (up to 64), and equal the folder name. `description` (up
to 1024 characters) is what the agent sees in its catalog, so say what the skill does and when to use it. Optional
front matter: `license`, `allowed-tools` (informational) and a `metadata` map.

## Use skills in an agent

```ts
import { createRuntime, defineAgent } from 'mayura';
import { loadSkills, withSkills } from 'mayura/skills';

const skills = await loadSkills('./skills');
const agent = defineAgent(withSkills(skills, {
  id: 'support', version: '1', instructions: 'You help customers.', model, tools: [lookupOrder], input, output,
}));
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai.responses', 'tool:orders.lookup', ...skills.permissions] } });
```

`withSkills` appends the catalog to the instructions and adds two read-only tools, `skills.load` (a skill's
instructions and file list) and `skills.read` (one of its text files). Grant `skills.permissions`
(`tool:skills.load`, `tool:skills.read`, `skills:read`) like any other tool. Skills can also be defined in code with
`defineSkill({ name, description, instructions, files })` and combined with `createSkillSet([...])`.

## What skills can and cannot do

- **They grant nothing.** A tool a skill mentions still needs its own grant; `allowed-tools` is informational.
- **Scripts are never run by this package.** A skill may bundle scripts; the agent can read them, and running one goes
  through your own approved tools or Code Mode.
- **Everything is read once, within bounds**, when the set is loaded: 64 skills, 128 files per skill, 256 KiB per file
  and 16 MiB in total by default (all adjustable). Symbolic links are refused and hidden entries skipped, so a skill
  cannot reach outside its folder. Binary files are listed but not readable.
- **Content is pinned.** Each skill has a SHA-256 digest over its front matter, instructions and files; the set's digest
  is the version of its two tools, so a durable run records exactly which skill contents it read.
- **The catalog is bounded** (16 KiB by default): agent instructions are limited to 64 KiB, so a skill set too large for
  that is refused when it is created, not truncated.
