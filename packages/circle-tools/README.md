# @agent-stack-starter-kits/circle-tools

Framework-agnostic TypeScript wrappers around the [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference), for the **kit's own chrome** — not for the agent.

The agent runs `circle` in a shell and reads its JSON itself, so this package no longer models the payment surface. What used to live here — x402 challenge parsing, chain selection, Gateway deposit methods, path-placeholder binding, payload validation against a published schema — existed so a typed tool had something to call, and `circle services pay` does all of it. What is left is what the terminal UI has to do for itself, before or beside the agent.

Wrapped commands:

| Command | Used for |
| --- | --- |
| `circle wallet status` | session check, Terms gate |
| `circle wallet login` (`--init`, `--otp`) | email + OTP login, run by the kit at startup |
| `circle wallet logout` | clear stored credentials |
| `circle wallet list` / `balance` | the pinned USDC readout, `/wallets`, `/balance` |
| `circle gateway balance` | `/gateway` |
| `circle services search` | `/discover`, and parsing a search the agent ran itself |

Two reasons the login flow stays here rather than moving to the agent. The user types their own email and one-time code, and the kit stores neither — and the CLI's login prompt reads from a terminal, which a shell tool's closed stdin is not. `circle wallet login` is on the agent's approval list for that second reason as much as the first.

Nothing here accepts Circle's Terms of Use. A host that has not accepted them is reported as a manual step, because an agent must never accept them for a user.

`parseServiceSearch(stdout)` is the one function written for the agent's side of the line: it reads a `circle services search --output json` payload the *agent* produced, so a numbered quick-pick in the chat keeps pointing at whichever search actually ran last. It never throws — its caller is a sniffer over arbitrary shell output, so anything that is not a search payload parses to nothing.
