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

## Handing off a long thread

Models make more tool-call mistakes as their window fills, so past
a share of the model's window (`ui.autoHandoffPercent`, 50 by default; the Hand off at slider offers 25, 50 and 75) a thread should move to a fresh one. Because it is a share, a model with a bigger window hands off later. `ui.autoHandoffTokens` ("Hand off at a fixed size") states it in tokens instead and wins over the share at the same level.
The rules are in core (`core/threads/longthreads.ts`), and the server applies
them after every turn settles, background turns included (`actOnLongThread` in
`core/threads/operations.ts`), so a thread no client has open is looked after
too. With `ui.autoHandoff` set to `ask` (the default) a client draws a card over
the composer with **Hand off** and **Not now**; with `auto` the server continues
the thread itself (the same handoff document as "Continue in a new thread", and
a `thread.continued` note marked `automatic`, which the TUI follows to the new
thread) as soon as nothing is running that the new thread would lose track of:
no turn, no subthread, no background task and no queued message. Until then the
card names what it waits for and the button hands off by hand. It is Moxen that
decides, not the model, and it fires at most once per thread. A delegated task is
never handed off, because its parent waits on that thread; it is compacted
instead when it can be. `off` turns the card and the automatic hand-off off.

Each provider can override all of it for its own threads: `providers.claude`,
`providers.opencode` and `providers.harness` take `autoHandoff`,
`autoHandoffPercent` and `autoHandoffTokens`, on that provider's settings page
under "Long threads". They also take `autoHandoffModels`, an object of model
slug to tokens for particular models (`{"claude-opus-4-5": 500000}`; `config set
providers.claude.autoHandoffModels "claude-opus-4-5=500k"` takes one
`model=tokens` pair per line or comma, `k` and `m` meaning thousands and
millions, and an empty value clears them all). On the settings page it is the
"Hand off at, per model" row: it lists the provider's models, enter on one picks
a size from 100K to 1M, and `d` removes that model's override. The line for a thread is the
first that is set: its model's tokens, the provider's tokens, the provider's
share, the global tokens, the global share, then half the window.

## Compacting a long thread (Claude Code)

By default Moxen, not Claude Code, compacts a Claude Code thread. It starts
every session with Claude Code's own auto-compaction off
(`autoCompactEnabled: false`) and the server watches the same context reading as
the hand-off, past `providers.claude.autoCompactPercent` of the window (80 by
default; the Compact at slider offers 50, 65, 80 and 90). `providers.claude.autoCompact`
says what happens then: `ask` (the default) shows a card with **Compact** and
**Not now**; `auto` sends `/compact` itself, the same as "Compact now", once no
turn is running and nothing is queued. Because Claude Code's own compaction is
off, `ask` does not wait for an answer forever: a delegated task (no one to ask)
is compacted at the line, and any thread halfway from the line to a full window
(90% with the defaults) is compacted unasked, with a notice saying why. Either
way it happens at most once until the thread drops below the line again; `claude`
leaves it all to Claude Code, whose own window (`autoCompactWindow`) then applies.
A hand-off card can show at the same time: with the defaults it comes first, at 50%.
OpenCode and the Moxen Harness have their own compaction settings and are not
affected.

## Revert

Revert rolls back every provider that saw a dropped turn, then cuts the
ledger. Files stay as they are unless asked back too (`--restore-files`),
in which case the worktree returns to the first dropped turn's snapshot
and the replaced state is pinned under a `revert-*` ref to undo by.

## Usage accounting

Drivers report per-turn usage deltas, recorded at settle and summed for
the usage panels. Providers that report nothing contribute zeros:
degradation, never invention.
