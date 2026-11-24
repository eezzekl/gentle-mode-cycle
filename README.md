# gentle-mode-cycle

One key press — or `/mode-cycle` — moves the gentle-shell session permission mode to
the next one. It is the permission-mode equivalent of Pi's model cycle (`ctrl+t`) or
thinking-level cycle (`shift+tab`): the mode changes without walking through
`/gentle:customize` → Editor → Session permissions.

**Requires gentle-shell.** The extension asks gentle-shell to change the mode, so
gentle-shell's own controller still applies the change and keeps its checks
(interactive session, identifiable workspace). Nothing is relaxed, and the status
bar keeps updating itself: gentle-shell publishes the mode label when the mode
changes. Without gentle-shell there is nothing to rotate.

## Rotation

```
normal → auto → yolo → normal
```

The rotation is counted from the mode the session is in now, not from the saved
default. `super-yolo` is left out of the rotation; if a session is already in
`super-yolo`, a press takes it to `normal` (never to a more permissive mode).

## Usage

| Action | What it does |
| --- | --- |
| `alt+m` | Move to the next session permission mode. |
| `/mode-cycle` | Same as the key. |

Every successful change shows a short notice (`Permissions: <MODE>`). A press
during a change in flight is ignored, so two quick presses never compute the next
mode from a stale read. If gentle-shell does not settle within 5 seconds, the press
gives up with a warning (the mode may not have changed) and the next press starts fresh.

## Changing the key

The key lives in the extension's own config file, `gentle-mode-cycle.json`, in Pi's
agent directory (`~/.pi/agent/` with Pi, `~/.local/share/gentle-shell/install/agent/`
with the self-contained Gentle Shell). It is a file, not an environment variable,
because the self-contained install launches Pi with a clean environment.

```json
{ "key": "alt+m" }
```

- `/mode-cycle key <key>` validates and saves it, e.g. `/mode-cycle key ctrl+shift+k`.
  **Run `/reload` afterwards**: Pi registers shortcuts only when extensions load.
  Use Pi's `/hotkeys` to check the new key does not conflict with another binding.
- `/mode-cycle key` with no argument opens a capture box (TUI only): press the
  combination you want and the box shows it as it will be saved, so there is no
  notation to get wrong (`alt-n`, or shift+n meaning a capital letter). Backspace
  clears what was captured, Enter confirms and saves it (then run `/reload`), Escape
  cancels without saving. A combination that cannot work, such as a bare key, is
  shown with the reason and cannot be confirmed.
  **Limitations:** while the box is open it receives the keys, so pressing the
  currently registered rotation key captures it instead of rotating the mode, and a
  combination Pi already binds is captured too — after saving, `/reload` prints Pi's
  shortcut-conflict warning and this extension wins, so check `/hotkeys` when in
  doubt. Keys your terminal or operating system consumes (for example `super`
  combinations on Windows) never reach it. On a terminal without the kitty keyboard
  protocol some `alt`+letter combinations arrive as another key (`alt+n` arrives as
  `alt+down`); the box shows what Pi sees and refuses to bind it. Without a TUI (RPC
  or print mode) `/mode-cycle key` alone only reports the typed usage.
- A key is one or more modifiers (`ctrl`, `alt`, `shift`, `super`) plus one base key.
  `ctrl+m` (terminals send Enter), `ctrl+i` (Tab), `ctrl+j` (line feed), a bare key
  and anything malformed are rejected.
- `"off"` (or `""`) registers no key; `/mode-cycle` keeps working.
- An invalid key in the file falls back to `alt+m` and warns once when the session
  starts. A missing or unreadable file means the defaults.
- `/mode-cycle status` shows the active key, whether `super-yolo` is included
  (`includeSuperYolo`, default off) and the config file path.
- Other fields in the file are preserved when the extension saves it.

## Install

Pi with the gentle-shell package:

```bash
pi install <source>
```

Self-contained Gentle Shell, which ships its own Pi runtime and agent directory:

```bash
~/.local/share/gentle-shell/install/bin/pi install <source>
```

`<source>` is this repository: a local path or its git URL. The extension needs no
configuration to start working.

## Requirements and compatibility

| | |
| --- | --- |
| Pi | `>=1.2.0` |
| Node | `^22.19.0 \|\| >=23.6.0` |
| gentle-shell | required; the mode contract was read from gentle-shell (gentle-pi) 5.0.0, commit `0d181e872` (2026-11-23), and verified live against the packaged self-contained install (gentle-pi 4.3.0 on Pi 1.3.0) |

Extension shortcuts are registered through Pi, so `/hotkeys` lists the effective
key and any conflict with a built-in binding.

The extension talks to gentle-shell through an internal, unversioned contract: the
`gentle:yolo:host-ui` event, its payload (`{ context, respond }`) and the adapter it
hands back (`readMode`, `setMode`, `dispose`). If gentle-shell renames that channel,
its payload, its adapter methods or its modes, rotation stops and this extension has
to be updated.

## Without gentle-shell, or when its contract changed

gentle-shell is required. If it does not answer, the press changes nothing and shows
`gentle-shell is not available: cannot rotate the permission mode.`

If gentle-shell is installed but renamed the internal contract below, its
`/gentle:yolo` command still exists. In that case the press shows
`gentle-shell did not answer: opening /gentle:yolo instead.` and opens that command,
so the mode can still be changed by hand. Rotation stays stopped until this
extension is updated.

## Development

```bash
pnpm install
pnpm test        # node --test over tests/
pnpm typecheck   # tsc --noEmit
```

The tests drive the extension through its public surface (the registered shortcut,
the registered command, the notices and the calls made on a fake gentle-shell
adapter), so they need no terminal session and no real gentle-shell.
