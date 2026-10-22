# Threads and turns

## Lifecycle

A turn goes from queued to running to settled. A running turn records the
process running it (pid and host). If that process dies mid-turn — a
crashed server, a killed CLI, a TUI closed during a turn — nothing would
ever settle it, so the next operation that touches the thread interrupts
the orphaned turn and runs the one queued behind it. A turn owned on
another host is never judged.

When a turn settles, its checkpoint and its context-window reading are
written before its outcome, so anyone who sees the turn complete also sees
both. Each turn records the model it actually ran on.

A turn's answer is the provider's final message. Notes the provider writes
between tool calls are kept as their own messages, so the transcript folds
them between the calls they narrate. Completed thinking is stored whole;
live thinking streams only.

## What a new thread starts with

One rule, most specific first, the same for `moxen handover`, `moxen threads create` and a thread started from the TUI (`resolveModelSelection` in `core/catalog/selection.ts`; the TUI marks the same model as the default in its picker):

- **Provider:** the request, then the project's stored default, then the global Provider, then the installation default (Claude Code when it is installed, or `MOXEN_DEFAULT_MODEL`). A project's own default beats the global Provider.
- **Model:** the request; the project's model when the thread is on the project's provider; the provider tab's Model; the global Model, only when the global Provider is this provider (a model belongs to one provider, so with no global Provider the global Model is ignored and the settings page says so); then the installation default's model when it is on this provider. A provider with none of these asks for `--model`.
- **Effort:** the request, the provider tab's Effort, then the global Effort. With no global Provider, the page offers only the levels every provider's model takes.
- **Permissions:** the request, the provider tab's Permissions, then the global one.
- **Checkout or worktree:** the request, the project's stored default, its `moxen.json`, then the global Thread environment. `auto`, which always meant the checkout, still loads and reads as `local`.

A follow-up, and a delegated task, keeps its parent thread's selection unless the request overrides it, and never falls back to the settings or the installation default.

## The activity ledger

The ledger records lifecycle bookkeeping plus one row per tool call,
append-only. Without the tool rows a turn that did real work would render
as a duration over a prompt echo, so rows are written while the turn runs.
A row is only appended when its signature changes, so streamed output does
not flood the ledger. Parked questions land as rows too: the answer panel
reads open questions off the ledger, so a question that never becomes a
row can never be answered. Tool approvals work the same way: a
`permission.requested` row carries the tool, its command or path, and the
agent's reason, and the permission panel (yes / yes for the session / no)
answers it with `thread.permission.respond`.

## Steering

Sending into a running turn steers it when the provider takes mid-turn
input (Claude, OpenCode) and is only recorded otherwise. A steer
never starts a second provider run.

Some providers wake a session on their own — a finished background task,
a monitor event. That output arrives as a turn like any other and is shown
in the side panel's Background tab, which can also list and stop running
background work. Background work lives in the session, so it outlasts a
turn only where the session does: in a shared server, or a client that
stays open.

## Live updates

The instructions a conversation began with are kept, not rewritten. What
changes since — edited rule files (sent as a patch, never the whole file),
MCP server sets, skills — rides ahead of the next prompt.

## Long threads: compaction and hand-off

Models make more tool-call mistakes as their window fills, so a long thread is
either compacted (its history summarised in place) or handed off (continued in
a fresh thread opened with a handoff document). Every provider's settings page
has the same "Long threads" group, and the Turns tab holds the defaults:

| Row | Key | Values |
| -- | -- | -- |
| Compaction | `providers.<kind>.compaction` | `provider`, `ask`, `auto`, `off` (the Moxen Harness: `auto`, `off`) |
| Compact at | `providers.<kind>.compactAt`, default `longThreads.compactAt` | a line |
| Kept word for word | `providers.harness.keepRecentTokens` | tokens (Harness only) |
| Hand off | `providers.<kind>.handoff`, default `longThreads.handoff` | `ask`, `auto`, `off` |
| Hand off at | `providers.<kind>.handoffAt`, default `longThreads.handoffAt` | a line |
| Hand off at, per model | `providers.<kind>.autoHandoffModels` | `model=tokens` pairs |

A **line** is a share of the model's window (`70%`, 10 to 95) or a size
(`32K`, `256K`, `1M`, or a plain token count; K and M count in powers of
two), with the same meaning on every tab. A share follows the window, so a
bigger model hands off later; a size suits a small local model. The page
offers shares from 40% and sizes from 8K.

**Precedence is specificity only**: the model's own size, then the
provider's tab, then the Turns tab, then the built-in default (hand off at
50%, compact at 80%; the Harness compacts at 70% of the window, 60% under
128K), whatever unit each level is written in. The rules are in core
(`core/threads/longthreads.ts`: `longThreadPolicy`, `handoffLineFor`,
`compactLineFor`), and the server applies them after every turn settles,
background turns included (`actOnLongThread` in `core/threads/operations.ts`),
so a thread no client has open is looked after too.

**Hand off.** `ask` (the default) draws a card over the composer with **Hand
off** and **Not now**; `auto` has the server continue the thread itself (the
same handoff document as "Continue in a new thread", and a `thread.continued`
note marked `automatic`, which the TUI follows) once nothing is running that
the new thread would lose track of: no turn, no subthread, no background task
and no queued message. Until then the card names what it waits for. It fires at
most once per thread, and never for a delegated task, whose parent waits on that
thread; that one is compacted instead when it can be. "Hand off at, per model"
lists the provider's models; enter on one picks a size from 16K to 1M, and `d`
removes it (`config set providers.claude.autoHandoffModels "claude-opus-4-5=500k"`
takes one `model=tokens` pair per line or comma, `k` and `m` meaning
thousands and millions).

**Compaction.** `provider` leaves it to the provider: Claude Code's own, which
takes a size under Compact at as its auto-compact window (100K to 1M), or
OpenCode's own, near the model's limit (its buffer, `compactBuffer`, is still
read from the file). `ask` and `auto` are Moxen's: it switches the
provider's own compaction off (Claude Code's `autoCompactEnabled: false`,
OpenCode's `compaction.auto`) and, past Compact at, shows a card or sends
`/compact` itself once no turn is running and nothing is queued. Because the
provider's own is off, `ask` does not wait forever: a delegated task is
compacted at the line, and any thread halfway from the line to a full window is
compacted unasked, with a notice saying why. A compaction that left the thread
past its line is not repeated until it has dropped below it once. `off`: nobody
compacts. The Moxen Harness compacts inside its own loop, so it only has
`auto` and `off` (see [providers](providers.md)).

**Both lines.** Hand-off is offered first when its line is lower than
compaction's. Past both, the lower line acts first: compaction set below the
hand-off line runs even with hand-off on Automatic, and the thread is handed
off if compacting did not bring it back below.

**Older keys** still load and mean what they did: `ui.autoHandoff`,
`ui.autoHandoffPercent`, `ui.autoHandoffTokens`, `providers.<kind>.autoHandoff`,
`autoHandoffPercent`, `autoHandoffTokens`, `providers.claude.autoCompact`
(`claude` is `provider`), `autoCompactPercent`, `autoCompactWindow`,
`providers.opencode.autoCompact` and `providers.harness.autoCompact`,
`autoCompactPercent`, `autoCompactTokens`. Each sits at its own level, just
below the key that replaced it, and the page's Default names it when it
applies. `moxen config set` on one still writes it, for an older build sharing
the file, and writes its replacement too.

## Revert

Revert rolls back every provider that saw a dropped turn, then cuts the
ledger. Files stay as they are unless asked back too (`--restore-files`),
in which case the worktree returns to the first dropped turn's snapshot
and the replaced state is pinned under a `revert-*` ref to undo by.

## Usage accounting

Drivers report per-turn usage deltas, recorded at settle and summed for
the usage panels. Providers that report nothing contribute zeros:
degradation, never invention.
