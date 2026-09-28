# mayura/terminal

Terminal front ends for agents: `runTerminalChat` (interactive, streaming, with per-turn cost), `runAgentCommand`
(one-shot commands whose flags come from the agent's input schema), and a person in the loop with
`confirmBeforeRunning` and `askPersonTool`, which refuse when nobody is at a terminal.
See [Run an agent in the terminal](../../docs/how-to/terminal.md).
