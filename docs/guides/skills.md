---
title: "Skills"
description: "Give an agent SKILL.md folders of task instructions that it loads only when a task needs them."
---

A skill is a named bundle of instructions for one kind of task, such as filling a form, writing release notes, or
deciding a refund under a policy, plus any reference files those instructions mention. An agent sees only each
skill's name and one-line description. When a task matches, it loads the skill's full instructions with a tool and
reads its files on demand. Dozens of skills cost almost nothing until one is used.

Skills use the open `SKILL.md` folder format, so skills written for other agent tools work in Mayura too. Use them
when an agent handles many kinds of tasks and you don't want every procedure in its instructions all the time.

```ts
import { createRuntime, defineAgent } from 'mayura';
import { loadSkills, withSkills } from 'mayura/skills';

const skills = await loadSkills('./skills');

const agent = defineAgent(withSkills(skills, {
  id: 'support', version: '1', instructions: 'You help customers of an online store.',
  model, tools: [lookupOrder], input, output,
}));

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:orders.lookup', ...skills.permissions] },
  limits: { maxCostMicros: 100_000 },
});
```

## Writing a skill

A skill is a folder with a `SKILL.md` file and, optionally, other files:

```text
skills/
  refund-policy/
    SKILL.md
    references/policy.md
```

`SKILL.md` starts with front matter, then the instructions in Markdown:

```markdown
---
name: refund-policy
description: Decide refunds under the store policy. Use when a customer asks for their money back.
---
# Refund policy

1. Read references/policy.md.
2. Refunds up to 50 EUR are automatic; above that, ask a person to approve.
```

| Front matter | Meaning |
|---|---|
| `name` | Required. Lower-case letters, digits and single hyphens, up to 64 characters. Must equal the folder name. |
| `description` | Required, up to 1,024 characters. The agent decides from this alone whether to load the skill, so say what it does and when to use it. |
| `license` | Optional text. |
| `allowed-tools` | Optional list of tools the skill expects. Informational only: it grants nothing. |
| `metadata` | Optional map of names to text. |

The front matter is a small YAML subset: `key: value` lines, quoted values, `>` and `|` block text, the
`allowed-tools` list and the `metadata` map. Unknown keys are ignored. `parseSkillFile(text)` exposes the same parser
if you want to check a file yourself.

## Loading skills

`loadSkills(sources, limits?)` takes one path or a list. Each path is either a single skill folder (it contains a
`SKILL.md`) or a folder of skill folders. Folders without a `SKILL.md`, hidden entries and `node_modules` are skipped.

Everything is read once, when the set is loaded, so later changes on disk do not change what the agent sees. Restart
or reload to pick up edits.

You can also define skills in code and combine them:

```ts
import { createSkillSet, defineSkill } from 'mayura/skills';

const refunds = defineSkill({
  name: 'refunds',
  description: 'Decide refunds under the store policy.',
  instructions: 'Read references/policy.md, then decide.',
  files: { 'references/policy.md': 'Refunds up to 50 EUR are automatic.' },
});
const skills = createSkillSet([refunds]);
```

`createSkillSet` also combines skills from different `loadSkills` calls (`createSkillSet([...a.skills, ...b.skills])`).
Skill names must be unique within a set.

## What the agent gets

`withSkills(skills, agentOptions)` returns the agent options with two changes:

- the **catalog** is appended to `instructions`: a short paragraph on how to use skills, then one line per skill with
  its name and description;
- two tools are added: `skills.load` and `skills.read`.

| Tool | Input | Returns |
|---|---|---|
| `skills.load` | `{ name }` | The skill's name, description, full instructions, and its file list (path, size, whether it is text). |
| `skills.read` | `{ name, path }` | The text of one file, by the path `skills.load` listed. |

Both tools are read-only (`effects: 'none'`) and cost nothing. Grant them with `skills.permissions`, which is
`['tool:skills.load', 'tool:skills.read', 'skills:read']`. Without those grants, the agent's first attempt to load a
skill ends the run with `PERMISSION_DENIED`.

If the set is empty, `withSkills` returns the options unchanged. It refuses an agent that already has tools with these
ids.

The `SkillSet` object also gives your own code access to the contents: `skills.get(name)`, `skills.readFile(name, path)`,
`skills.catalog()` and `skills.skills`.

## Permissions and scripts

**Skills never grant anything.** A skill that says "use the refund tool" does not give the agent that tool or its
permission; the tool must be in the agent's `tools` and granted in the runtime like any other.

**Mayura never runs a skill's scripts.** A skill may bundle scripts; the agent can read them as text. Running code goes
through tools you define and grant, or through [Code mode](code-mode.md).

## Limits

| Limit | Default |
|---|---|
| `maxSkills` | 64 skills in a set |
| `maxFilesPerSkill` | 128 files besides `SKILL.md` |
| `maxFileBytes` | 256 KiB per file, `SKILL.md` included |
| `maxTotalBytes` | 16 MiB across all skills |
| `maxCatalogBytes` | 16 KiB for the catalog added to the instructions |

Pass them as the second argument to `loadSkills` or `createSkillSet`. A set over a limit is refused when it is created,
never silently truncated. An agent's instructions are limited to 64 KiB in total, catalog included.

## Good to know

- **Contents are pinned.** Each skill has a SHA-256 `digest` over its front matter, instructions and files; the set's
  `digest` covers every skill and is also the `version` of the two tools. A durable run therefore records exactly
  which skill contents it read.
- **Skills stay in their folder.** Symbolic links are refused, file paths cannot contain `..`, and nesting is limited
  to 8 levels.
- **Binary files are listed but not readable.** `skills.read` returns text files only.

## Related

- [Agents](../concepts/agent.md)
- [Tools](../concepts/tools.md)
- [Permissions](../concepts/permissions.md)
- [Memory and context](memory-and-context.md)
- [Code mode](code-mode.md)
