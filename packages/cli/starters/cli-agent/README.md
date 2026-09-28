# Command-line assistant

An AI assistant for your terminal, built on [Mayura](https://github.com/KartikeyAI/mayura). Chat with it, or ask it one
thing and get one answer, about the folder you run it in. It can list, read and search files there, write files you
confirm first, ask you a question when it is stuck, and load skills (`SKILL.md` folders) for tasks that need a
procedure. It never leaves that folder and never opens `.env` files, `.git` or `node_modules`.

It runs offline out of the box: a rule-based stand-in plays the model, so everything works and tests without a key.
Point it at a real model in `.env` when you are ready.

## Quick start

```bash
npm install
npm run dev
```

`npm run dev` builds the project and starts a chat about this folder. Try:

```text
list files
read README.md
search TODO
write notes.md: remember to add tests
how do I write release notes?
```

Offline, the assistant understands only these phrasings. With a real model it understands anything, streams its
replies, and chooses its own tools. In the chat, `/help` lists the commands, `/clear` starts over, `/cost` shows what
the conversation has spent and `/exit` leaves.

One request at a time, for scripts:

```bash
npm run build
npm run ask -- list files in src
npm run ask -- --json search TODO
echo "read package.json" | npm run ask
```

The exit code is 0 when the request succeeded and 1 otherwise. `--json` prints `{ status, output, spentMicros }`.

With a model that can see (OpenAI, Anthropic, or a compatible provider with `MAYURA_MODEL_MEDIA`), attach images or
PDFs with `--attach`, as many times as needed: `npm run ask -- --attach screenshot.png what is wrong on this screen?`.
The file's type is read from its bytes; the offline stand-in cannot see, so it refuses attachments.

### Use it in any folder

The assistant works on the folder you run it from (or `ASSISTANT_ROOT`). To have an `assistant` command everywhere:

```bash
npm run build
npm link
cd ~/some/other/project
assistant chat
assistant "what does this project do?"
```

## Use a real model

Set the provider in `.env` (copy `.env.example`; `mayura init` may already have written one for you):

```bash
MAYURA_MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
MAYURA_MODEL=claude-sonnet-5
MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS=3000000
MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS=15000000
MAYURA_MODEL_MAX_CALL_COST_MICROS=50000
MAYURA_MAX_RUN_COST_MICROS=500000
```

Prices are in micros (millionths of a dollar) per million tokens; check your model's current prices. The two caps
limit one model call and one turn: a turn that would cost more is stopped before the call is made. OpenAI
(`openai` with `OPENAI_API_KEY`) and any OpenAI-compatible provider (`compatible`, see `.env.example`) work the same
way. `npm run chat` and `npm run ask` load `.env` from this project; real environment variables win.

## What is where

| File | What it does |
|---|---|
| `src/cli.ts` | The `assistant` command: `chat` starts a chat (`runTerminalChat`), anything else is one request (`runAgentCommand`). |
| `src/assistant.ts` | The agent: its instructions, tools, skills, and the offline stand-in model. |
| `src/workspace.ts` | The file tools, and every rule that keeps them inside the workspace. |
| `src/config.ts` | Settings from the environment, validated at startup. |
| `src/model.ts` | Picks the model adapter for the configured provider. |
| `skills/` | Skills the agent can load. `release-notes` is an example. |
| `test/` | Offline tests: one-shot requests, the chat with a confirmed write, the safety rules, skills and settings. |

## How it stays safe

- **Nothing is allowed unless granted.** The runtime (in `src/cli.ts`) grants exactly the assistant's model, its
  tools, `effect:read`, and `effect:write` with `files:write` for writing. Nothing else can run.
- **One folder.** Paths are relative to the workspace. `..`, absolute paths and symbolic links that lead out of it are
  refused by checking the real path on disk. `.env` files, `.git` and `node_modules` are never listed, read, searched
  or written, so your keys never reach the model.
- **You confirm every write.** Before `files.write` runs, you see the file, whether it is new, and the start of the new
  content, and you answer "Allow it?" (the default is no). Declining ends that turn. With nobody at a terminal (a pipe,
  a script, CI), writes are refused.
- **Costs are capped** per model call and per turn, and the chat shows what each turn cost.

## Make it yours

- **Add a tool.** Define it with `defineTool` next to the file tools, add it to `tools` in `src/assistant.ts`, and
  grant `tool:<id>` (and its effect and capabilities) in `permissions`. Wrap anything that changes something in
  `confirmBeforeRunning`.
- **Add a skill.** Create `skills/<name>/SKILL.md` with a `name` and a `description` (see `skills/release-notes`). The
  agent sees each skill's name and description and loads the full text only when a task needs it.
- **Change its personality** in the instructions in `src/assistant.ts`.
- **Structured input.** The agent takes text. For flags such as `--city Paris`, give it a Zod object as `input`: the
  command's flags and `--help` come from it.

## Know the limits

- Offline, the stand-in understands only the phrasings above; it is a test double, not a model.
- The assistant reads text files up to 64 KiB each (longer ones are cut), lists up to 200 entries per folder and
  returns up to 50 search matches. Search skips files over 256 KiB and stops after 2,000 files.
- A write replaces the whole file. There is no undo, so keep the folder under version control.
- Declining a write ends the turn: the model does not get to try something else in the same turn.
- The chat remembers the last 20 turns of this session only; nothing is saved between sessions.
- It runs code you wrote, not code the model writes: there is no shell tool. If you add one, confirm every command.
