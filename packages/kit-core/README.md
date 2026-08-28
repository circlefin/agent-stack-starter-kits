# @agent-stack-starter-kits/kit-core

Everything the six kits share, so that a kit's own source is only the adapter between this package and its framework's agent and tool APIs. It sits one layer above [`circle-tools`](../circle-tools) — those are the CLI reads the terminal UI does for itself; these are what the *agent* is given.

The agent is given three tools — a shell, a file reader and a grep — and almost no prompt. There is no typed tool per Circle command and no playbook: it runs `circle` in a shell, and Circle's own skills — installed on the machine, read off disk — tell it how.

## Subpath exports

| Import | Module | Contents |
| --- | --- | --- |
| `…/kit-core/tools` | `src/tools.ts` | The three tool bodies, their descriptions, the approval prompt |
| `…/kit-core/shell` | `src/shell.ts` | The shell itself: environment, timeout, output cap |
| `…/kit-core/approval` | `src/approval.ts` | Which commands stop for the user |
| `…/kit-core/skills` | `src/skills.ts` | Circle skills discovered on disk |
| `…/kit-core/instructions` | `src/instructions.ts` | The system prompt and the opening turn |
| `…/kit-core/balance` | `src/balance.ts` | The pinned USDC readout |
| `…/kit-core/commands` | `src/commands.ts` | The slash-command router |
| `…/kit-core/fatal` | `src/fatal.ts` | How a run that threw is reported |
| `…/kit-core/theme` | `src/theme.ts` | Terminal color and formatting helpers |

The package root (`.`) re-exports all of them.

## `tools`

Three tools, and the bodies behind them. Each kit's `tools.ts` is a schema and a one-line call into these, which is what keeps six frameworks from drifting apart on what a tool does or how its failure reads. Two kits take fewer: the Claude Agent SDK kit uses the SDK's `Bash`, `Read`, `Grep` and `Glob`, and the LangChain kit uses Deep Agents' file tools next to `shell` from here — those frameworks ship their own, and Deep Agents rejects a custom tool that shadows one of its built-in names.

- `shell` — run a command and return stdout and stderr interleaved, plus the exit status. A non-zero exit comes back as an ordinary result to read, never a thrown error: a throw hides the stderr that says what to fix, and in some frameworks takes the whole call down with it.
- `read_file` — read a text file with line numbers, whole or by `offset`/`limit`. The numbering is what lets a `grep` hit and a later read refer to the same place.
- `grep` — search a file or a directory tree for a regular expression, optionally filtered by glob.

The last two are not decoration. A marketplace search is thousands of lines of JSON schema, more than a tool result should carry, so the agent redirects it to a file and goes back for the part it needs — the way a person does. Without a reader, going back means running the search again, and on a paid call that is a second charge.

- `TOOL_NAMES`, `TOOL_DESCRIPTIONS`, `PARAM_DESCRIPTIONS` — single-sourced model-facing copy. These say **what a tool does and what its arguments mean, and nothing about when to call it**; sequencing belongs to Circle's skills, which are the only thing in these kits that instructs the agent.
- `executeShell` / `executeReadFile` / `executeGrep` — the bodies, taking a `ToolIo` for logging and, where the framework has no external permission hook, the `ask` that raises the approval prompt.
- `approveCommand(ask, command, io)` — print the command, say what kind of thing it is, and wait for `y/N`.
- `REJECTED_MESSAGE` — what a declined command reports back: nothing ran, nothing was spent, do not retry it as written.
- `preview()` — collapse a value to one capped line, for compact log output.

## `approval`

- `requiresApproval(command)` — true when a shell line moves USDC or lifts the caps on it. The line is split on `;`, `|`, `&&` and `||` first and every segment judged on its own, so a payment behind a pipe or inside a `$(…)` cannot slip past. `--estimate` and `--help` are exempt, because prompting for a call that spends nothing trains people to approve payment dialogs without reading them.
- `describeApproval(command)` — the plain-language reason, for a reader who is not fluent in the CLI. The command itself is always shown too, and is the authority.

This is not a sandbox. It will not stop the agent deleting a file, installing a package or fetching from anywhere. The ceiling no instruction can argue past is `circle wallet limit set`, which confirms by one-time code and is therefore the user's to run.

## `shell`

`runShell(command, options)` and `formatShellResult(result)`. POSIX shell, home directory, three-minute timeout, killed by process group so a timeout takes the whole pipeline with it. Output is capped at 30k characters, and the cut says what to do about it rather than only that it happened.

The child environment is a short allowlist — `PATH`, `HOME`, the keyring variables the Circle CLI needs to find its session, and little else. The kit's own `.env` holds an LLM provider key the agent has no use for; forwarding the whole environment would put that key one `env` away from anything the model reads back. `CIRCLE_ACCEPT_TERMS` is absent for a different reason: accepting Circle's Terms of Use is not something an agent may do for a user.

## `skills`

- `SKILLS_DIR` — `~/.agents/skills`, the registry's tool-neutral store that `~/.claude/skills` and its equivalents symlink into. Installing once shares the skills with every agent on the machine.
- `listSkills()` / `hasSkills()` — read fresh each call, never cached: the agent installs skills *during* its first run, and a cache taken before that would report an empty machine for the rest of the session.
- `formatSkillsIndex(skills)` — one line per skill: name, path, and a capped description.

## `instructions`

- `buildInstructions()` — the whole system prompt: a line of identity, three rules for working a terminal, and the skills index. Nothing about Circle, which is the skills' job.
- `buildInitialPrompt()` — Circle's bootstrap line on a machine with no skills, so the first turn installs them; a status check once they are there.
- `BOOTSTRAP_PROMPT`, `SETUP_SKILL_URL` — the constants behind that.

## `balance`, `commands`, `theme`, `fatal`

`createBalanceReadout` drives the pinned USDC line, with an awaited `refresh()` for startup and a fire-and-forget `refreshSoon()` for the end of a turn. `createCommandRouter` answers `/help`, `/wallets`, `/balance`, `/gateway` and `/discover` from the CLI without spending a model turn, and resolves a bare number against the last marketplace search — including one the agent ran in its own shell, which the shell tool notices and re-arms.

`theme` is dependency-free ANSI that switches off when stdout is not a TTY or `NO_COLOR` is set; each kit re-exports it and adds only its own `kitLine` tag. It also holds the two frames a turn prints in, so six frameworks end a turn identically: `replyBlock(text)` for a finished answer, and `streamedBlock(text)` for prose that arrives mid-turn in the kits whose frameworks stream it.

`reportFatal(error, kitLine)` prints the one message a run that threw ends on, classifying an overloaded provider (HTTP 529, or the word in a subprocess's output) as transient rather than letting it read as a kit bug.

## Scripts

- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — `tsc -p tsconfig.json`
- `bun run clean` — remove build output
