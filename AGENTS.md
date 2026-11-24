# AGENTS.md

Orientation for agents working in this repository. Pi reads this file as project
instructions; keep it factual and short.

## What this repository is

A standalone Pi extension that rotates the gentle-shell **session permission mode**
with one key (`alt+m`) or `/mode-cycle`. TypeScript, **no build step**: Pi strips the
types (`package.json` declares the manifest `pi.extensions: ["./extensions"]`).

It never imports gentle-shell (that package exports nothing) and never sets a mode by
itself: gentle-shell's own `setMode` applies the change, keeping its interactivity and
workspace-identity checks.

Users read `README.md`. The specification, the decisions and the evidence live in
`odd/tasks/gentle-mode-cycle.md` — **read it before changing behaviour**. Specs S1–S8
quote the user's own words verbatim, and the Log records why each choice was made.
Append to the Log; never rewrite an earlier entry.

## Layout

| Path | What it is |
| --- | --- |
| `extensions/gentle-mode-cycle.ts` | Pi entry point: the shortcut, the `/mode-cycle` command, the notices, the bell. |
| `lib/modes.ts` | The four modes and the rotation rule. |
| `lib/mode-cycle.ts` | One rotation: discover, read, set, and its time budget. |
| `lib/host-ui.ts` | The gentle-shell channel: payload, timeout, adapter disposal. |
| `lib/config.ts` | The config file, the agent directory and key validation. |
| `lib/key-capture.ts` | The capture box: raw input, legacy sequences, keybinding conflicts. |
| `lib/notices.ts` | Every user-facing string. |
| `tests/` | The suite by area; `tests/support/mode-cycle-harness.ts` holds the shared fakes. |
| `odd/tasks/gentle-mode-cycle.md` | Specification, tasks, decisions and evidence. |

## Checks

```bash
pnpm install     # once
pnpm test        # node --test tests/*.test.ts — Node 24 strips the types, no bundler
pnpm typecheck   # tsc --noEmit
```

Both must pass before a work unit is finished. The suite is split by area and the
shared helpers live in `tests/support/mode-cycle-harness.ts`: a fake Pi, a fake
gentle-shell whose listener keeps the real `context` guard, and injected temporary
agent directories. Never point a test at the real agent directory, and never weaken a
test to make a change pass — when behaviour changes, the test that pins it changes in
the same commit.

## Conventions

- Code, comments, identifiers, tests, commit messages and README are **English**. The
  feature document keeps the user's Spanish quotes verbatim.
- Conventional Commits; one work unit per commit, with its tests and docs alongside the
  behaviour.
- A behaviour change starts with a failing test: observe RED, then GREEN.
- Comments say why, not what.
- Nothing is pushed by default; push, PR and release are the human's decisions.

## Invariants

Breaking one of these is a bug, not a style choice.

1. Never write the mode label (`gentle:mode` status): gentle-shell publishes it when the
   mode changes, and writing it could show a mode that failed to apply.
2. The change always goes through gentle-shell's `setMode`; nothing here may relax its
   interactivity or identity checks.
3. The discovery payload carries `{ context, respond }`: gentle-shell's listener ignores
   a request without a truthy context.
4. The adapter is disposed exactly once, on every path, including a late or repeated
   answer.
5. `super-yolo` stays out of the rotation unless the config holds the literal boolean
   `true`, and a press in flight must not enter it after the user turned it off (the flag
   is read again after the current mode is read).
6. The whole rotation is bounded by `ROTATION_TIMEOUT_MS`: a press ends in a change or a
   notice, never in silence, and it always releases the in-flight lock.
7. Two presses never compute the next mode from a stale read: keep the in-flight lock.
8. The agent directory is never hard-coded: `PI_CODING_AGENT_DIR` (with `~` expanded),
   else `~/.pi/agent`.
9. The bell writes at most one `\x07`, only for a change landing on `normal`, and only in
   a TUI session (never print, JSON or RPC).

## Pi extension facts that cost us time

- `pi.registerShortcut(key, …)` performs **no validation**: an invalid key is stored and
  silently never fires. Validate before registering.
- `ctx.ui.custom(factory)` receives `(tui, theme, keybindings, done)`; the component
  implements `render(width)`, `handleInput(data)`, `invalidate()` and closes through
  `done(value)`. `keybindings.getEffectiveConfig()` is the binding table (id → key(s));
  Pi's reserved ids are private in its runner and are mirrored in `lib/key-capture.ts`.
- Import `@earendil-works/pi-tui` **dynamically and defensively**, only when the capture
  box opens: the host supplies its own copy at runtime, and the devDependency only feeds
  types and tests.
- A deep import into `@earendil-works/pi-coding-agent/dist/...` is blocked by that
  package's `exports` map; the tests use the public API.
- Do not import the host package at load time to resolve a path: a second copy of Pi in
  the extension host buys nothing (`getAgentDir()` is exactly the rule in invariant 8).

## gentle-shell facts

- Channel `gentle:yolo:host-ui`, payload `{ context, respond }`, adapter
  `readMode()` / `setMode(mode)` (one argument, the context is already bound) /
  `dispose()`; the reference discovery wait is 100 ms; modes are `normal`, `auto`,
  `yolo`, `super-yolo`.
- Legacy terminals without the kitty keyboard protocol parse `ESC n` as `alt+down`
  (also `b`/`f`/`p` as left/right/up) while `ESC m` stays `alt+m`; a kitty terminal sends
  `ESC[110;3u` for `alt+n`.

## Environment

The install that has to keep working is the self-contained Gentle Shell at
`~/.local/share/gentle-shell/install` (Pi 1.3.0, packaged gentle-shell `gentle-pi`
4.3.0, Node 24.18.0). The contract was read from gentle-shell `gentle-pi` 5.0.0, commit
`0d181e872`, in `../gentle-shell`. The extension is installed there by path reference, so
a source change needs `/reload` or a new session.
