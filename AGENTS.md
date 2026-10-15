# AGENTS.md

Moxen (`moxen`) is an interactive terminal UI plus CLI for coding-agent
threads. It drives `claude` and `opencode` directly (GPT and Grok go through OpenCode)
(Bun + TypeScript + React via `@opentui/react`) — provider CLIs own their
logins; this tree never touches *their* credentials. The few keys Moxen owns
(a harness profile's API key, a search key) live only in the OS keychain.

- How it runs: [`docs/overview.md`](docs/overview.md),
  [`docs/threads.md`](docs/threads.md),
  [`docs/providers.md`](docs/providers.md).
- How to work on it: [`docs/contributing.md`](docs/contributing.md) — read
  it before changing code. The short version: one core (`src/core/`),
  one boundary (`src/server/` `ClientApi`, which every client goes
  through), two clients (`src/cli/`, `src/tui/`).
- Rules that always apply: check `git status` first, keep CLI `--json`
  envelopes backward compatible, never print a credential or write one to a file (the OS keychain, through
  `core/secrets.ts`, is the only place Moxen keeps one), and
  run `bun run check` before claiming completion.

Commands: `bun install`, `bun run check`,
`bun src/tui/render-check.tsx`, `moxen --json doctor`,
`moxen server start|status|stop`.
