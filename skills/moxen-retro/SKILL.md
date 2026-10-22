---
name: moxen-retro
description: Run a retrospective on a coding session and suggest improvements to the agent's environment.
argument-hint: "Which session? (default: this one)"
disable-model-invocation: true
metadata:
  credits:
    skill: retro
    author: Matt Pocock
    url: "https://github.com/mattpocock/skills/tree/main/skills/engineering/retro"
---

The user has asked for a **retrospective**. You are suggesting improvements to the coding agent's
**environment** (the repo, its steering files, its checks, its tools) so future runs go better. You
are not reviewing the code that was written, and you change nothing until the user picks candidates.

## Steps

1. Read the primary sources for the session the user names. Default to the current one.
   - Another Moxen thread: `moxen --json threads search <query>` to find it, then
     `moxen --json threads read --thread <id> --view turn-items` for the full, untruncated transcript (load the
     `moxen-threads` skill first if you have not).
   - This session: your own context is the source. Re-read the tool calls, not just the messages.
   - Note where the time went: long searches, repeated failures, corrections from the user, tool
     output that was far larger than what was used.

2. Read the repo's own guardrails before proposing any: `AGENTS.md` / `CLAUDE.md`, the `check` /
   `lint` / `typecheck` / `test` scripts in `package.json` (or the build tool's equivalent), the CI
   workflow, and any pre-commit hook. A check that already exists but is unwired or silently broken
   is the finding, not a new one.

3. Look for candidates in these categories. Each has a _use when_ — skip a category it does not
   apply to.

   - **Navigation**: how easy was it to find the right files? Are there hidden dependencies between
     files? Would a **navigation pointer** (one line in a steering file, or a docs page) help?
     _Use when_ the session took a long time to find a piece of information.
   - **Automated checks**: could linting, typing, tests or a filesystem check have caught a mistake
     the agent made? A repo with no guardrail at all (no pre-commit hook and no CI job running its
     lint, typecheck and test command) is itself a finding. _Use when_ a check could have caught
     the mistake, or the repo has no guardrail.
   - **Coding standards**: did a review miss something? Classify the miss first. A **mechanical**
     one (a banned API, an import shape, a file-location rule) gets a deterministic check — a lint
     rule, a hook, a CI job — not prose. Reserve a standards file for **judgement calls** no check
     can replace. _Use when_ a reviewer failed to catch a mistake.
   - **Steering files**: is `AGENTS.md` / `CLAUDE.md` (in the repo or the user's global scope)
     large? Move rules into checks or standards, and keep only navigation pointers. _Use when_ the
     file is long.
   - **Tool economy**: did the agent make expensive tool calls that could be streamlined? Is any
     custom tooling (a CLI, an MCP server) token-inefficient? _Use when_ a call was expensive.
   - **No-ops**: instructions in steering files that do not change the agent's behavior. _Use when_
     the steering files are large and unwieldy.
   - **Information access**: could the agent have been given something it lacked — dev-server logs,
     read-only access to a service? _Use when_ a crucial piece of information was not available.

4. Present the candidates to the user, most severe first. For each: the category, the evidence from
   the session (what happened, where), and the one concrete change. Then ask which to apply.

## Reference

Work goes through two stages: **implementation** and **review**. The implementation agent has the
most context pressure (exploring, writing, debugging), so it should get few instructions. The
review agent receives a diff and has little context pressure, so it is the one to impose coding
standards.

- `AGENTS.md` / `CLAUDE.md` reach every agent in the repo. Use them very sparingly, for navigation
  pointers to other files.
- A standards file is read during review, not implementation. Split it into docs when it passes
  about 1,000 lines.
- Docs are reference files, pointed to by other files. Look for an existing doc before writing one.
- Skills hold docs (their description is always in context) and user-invoked commands. Keep a
  skill's description short and say when to use it.
