# mayura/skills

Agent skills in the open `SKILL.md` folder format: `loadSkills(folder)` reads them once, within bounds;
`withSkills(skills, agentOptions)` adds the catalog (names and descriptions) to an agent's instructions and the
read-only `skills.load` and `skills.read` tools. Skills never grant permissions and scripts are never run here.
See [Give an agent skills](../../docs/guides/skills.md).
