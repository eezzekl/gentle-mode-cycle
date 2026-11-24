# gentle-mode-cycle

One key press — or `/mode-cycle` — moves the gentle-shell session permission mode to
the next one. It is the permission-mode equivalent of Pi's model cycle (`ctrl+t`) or
thinking-level cycle (`shift+tab`): the mode changes without walking through
`/gentle:customize` → Editor → Session permissions.

**gentle-shell is required.** The extension asks gentle-shell to change the mode, so
gentle-shell's own controller applies it and keeps its checks (interactive session,
identifiable workspace). Nothing is relaxed, and the status bar keeps updating
itself: gentle-shell publishes the mode label when the mode changes. Without
gentle-shell there is nothing to rotate (see [Without gentle-shell](#without-gentle-shell)).

## Usage

| Command                          | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `alt+m`                          | Move to the next session permission mode. The key is configurable.          |
| `/mode-cycle`                    | Same as the key.                                                            |
| `/mode-cycle key`                | Capture a new key with the keyboard (TUI only).                             |
| `/mode-cycle key <key>`          | Set the key explicitly, e.g. `ctrl+shift+k`.                                |
| `/mode-cycle key off`            | Register no key; the command keeps working.                                 |
| `/mode-cycle status`             | Show the active key, whether `super-yolo` is included, and the config file. |
| `/mode-cycle super-yolo on\|off` | Include `super-yolo` in the rotation, or leave it out.                      |

Every successful change shows a short notice (`Permissions: <MODE>`). A press during
a change in flight is ignored, so two quick presses never compute the next mode from
a stale read. If gentle-shell does not settle within 5 seconds the press gives up
with a warning (the mode may not have changed) and the next press starts fresh.

## Rotation

```
normal → auto → yolo → normal
```

The rotation is counted from the mode the session is in now, not from the saved
default. `super-yolo` is left out; if a session is already in `super-yolo`, a press
takes it to `normal`, never to a more permissive mode.

### Including super-yolo (opt-in)

`super-yolo` — no permission prompts — is **off by default, on purpose**: pressing the
key a few times must never land there by accident.

```
/mode-cycle super-yolo on     # normal → auto → yolo → super-yolo → normal
/mode-cycle super-yolo off    # back to the default rotation
```

The choice is saved as `includeSuperYolo` and read on every press, so it applies to
the **next press** with no `/reload`. Anything other than `on` or `off` is rejected
and changes nothing; entering `super-yolo` is impossible while the option is off.

## The key

### Capture it with the keyboard

`/mode-cycle key` with no argument opens a box in the TUI: press the combination and
the box shows it as it will be saved, so there is no notation to get wrong (`alt-n`,
or shift+n meaning a capital letter). **Backspace** clears it, **Enter** confirms and
saves, **Escape** cancels without saving. A combination that cannot work — a bare
key, for instance — is shown with the reason and cannot be confirmed. Run `/reload`
afterwards: Pi registers shortcuts only when extensions load.

Conflicts are reported inside the box:

- A combination that is a **Pi built-in binding** (`alt+down` is
  `app.models.reorderDown`, for example) can still be saved: this extension wins, and
  Pi prints its own conflict warning on `/reload`.
- A combination **Pi reserves for itself** is refused, because Pi skips the
  registration and the saved key would never fire.

What the box cannot see: keys your terminal or operating system consumes (for
example `super` combinations on Windows) never reach it; and on a terminal without
the kitty keyboard protocol some `alt`+letter combinations arrive as another key
(`alt+n` arrives as `alt+down`), which the box shows and refuses to bind. While the
box is open it receives the keys, so pressing the currently registered rotation key
captures it instead of rotating the mode. Without a TUI (RPC or print mode)
`/mode-cycle key` alone only reports the typed usage.

### Set it explicitly

`/mode-cycle key <key>` validates and saves a key written by hand, e.g.
`/mode-cycle key ctrl+shift+k`; `/mode-cycle key off` registers none. Run `/reload`
afterwards, and use Pi's `/hotkeys` to check the result and its conflicts.

A key is one or more modifiers (`ctrl`, `alt`, `shift`, `super`) plus one base key
(a letter, a digit, or a named key such as `enter`, `tab`, `escape`, the arrows,
`home`, `end`, `pageup`, `pagedown`, `insert`, `delete`, `backspace` or `f1`–`f12`).
Rejected: `ctrl+m` (terminals send Enter), `ctrl+i` (Tab), `ctrl+j` (line feed), a
bare key, unknown or repeated modifiers, and anything malformed.

### Where it lives

The key is in the extension's own config file, `gentle-mode-cycle.json`, in Pi's
agent directory: `PI_CODING_AGENT_DIR` when set (with `~` expanded), otherwise
`~/.pi/agent` — so `~/.local/share/gentle-shell/install/agent/` in the
self-contained Gentle Shell. It is a file and not an environment variable because
that install launches Pi with a clean environment.

An invalid key in the file falls back to `alt+m` and warns once when the session
starts. A missing or unreadable file means the defaults. `/mode-cycle status` shows
the active key, whether `super-yolo` is included, and the file path.

## Sound when the cycle returns to `normal`

`normal` shows no label in the status bar, so a press that lands on it would be
silent. For that one case the extension rings the **terminal bell**: a single `\x07`
byte. It does not play a file or reuse gentle-shell's notification sounds.

It rings only when a press **changed** the mode and the new mode is `normal`, in the
interactive TUI. It never rings for `auto`, `yolo` or `super-yolo`, for a refused
change, an unknown mode, a timeout, gentle-shell being unavailable or the
`/gentle:yolo` fallback, nor in print, JSON or RPC modes.

Whether you hear anything is the **terminal's** decision: the bell may be an audible
beep, a visual flash or nothing. In Windows Terminal, `bellStyle` silences it or
turns it into a flash.

## Configuration

`gentle-mode-cycle.json` in Pi's agent directory. Every field is optional:

| Field              | Default   | What it does                                                                |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `key`              | `"alt+m"` | The rotation shortcut. `"off"` or `""` registers none.                      |
| `includeSuperYolo` | `false`   | Include `super-yolo` in the rotation.                                       |
| `notify`           | `true`    | Show the success notice (`Permissions: <MODE>`). Warnings are never hidden. |
| `bellOnNormal`     | `true`    | Ring the bell when a press lands on `normal`.                               |

```json
{
  "key": "alt+m",
  "includeSuperYolo": false,
  "notify": true,
  "bellOnNormal": true
}
```

`includeSuperYolo`, `notify` and `bellOnNormal` are read on every press, so a hand
edit applies to the next press with no `/reload`; `key` needs `/reload`. A value
that is not a boolean keeps that field's default. Writes merge into the file, so
fields this version does not know are preserved.

## Install

Pi with the gentle-shell package:

```bash
pi install <source>
```

Self-contained Gentle Shell, which ships its own Pi runtime and agent directory:

```bash
~/.local/share/gentle-shell/install/bin/pi install <source>
```

`<source>` is whatever you pass to `pi install`, which accepts:

| Form | Example |
| --- | --- |
| A local path | `pi install ~/source/repos/gentle-mode-cycle` |
| A git URL | `pi install git:github.com/<owner>/gentle-mode-cycle` |
| An npm package | `pi install npm:@scope/gentle-mode-cycle` |

A local path installs a reference to that path, so a change to the source needs
`/reload` or a new session. The extension needs no configuration to start working.

With the self-contained Gentle Shell, use the same source with its bundled `pi`
(`~/.local/share/gentle-shell/install/bin/pi install …`). Gentle Shell has no separate
install command for extensions: its own rule is to go through Pi's.

## Requirements and compatibility

|              |                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi           | `>=1.2.0`                                                                                                                                                                                              |
| Node         | `^22.19.0 \|\| >=23.6.0`                                                                                                                                                                               |
| gentle-shell | required; the mode contract was read from gentle-shell (gentle-pi) 5.0.0, commit `0d181e872` (2026-11-23), and verified live against the packaged self-contained install (gentle-pi 4.3.0 on Pi 1.3.0) |

The extension talks to gentle-shell through an internal, unversioned contract: the
`gentle:yolo:host-ui` event, its payload (`{ context, respond }`) and the adapter it
hands back (`readMode`, `setMode`, `dispose`). If gentle-shell renames that channel,
its payload, its adapter methods or its modes, rotation stops and this extension has
to be updated.

## Without gentle-shell

gentle-shell is required. If it does not answer, the press changes nothing and shows
`gentle-shell is not available: cannot rotate the permission mode.`

If gentle-shell is installed but changed the internal contract above, its
`/gentle:yolo` command still exists. The press then shows
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
the registered command, the notices, the bell writer and the calls made on a fake
gentle-shell adapter), so they need no terminal session and no real gentle-shell.

[![Built with Gentle-AI](https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png)](https://github.com/Gentleman-Programming/gentle-ai)
