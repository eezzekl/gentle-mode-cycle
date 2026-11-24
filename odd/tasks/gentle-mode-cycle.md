# Feature: gentle-mode-cycle — rotate the session permission mode with one key

Standalone Pi extension, add-on to gentle-shell. One key press (default `alt+m`) or `/mode-cycle` moves the session permission mode to the next one: `normal → auto → yolo → normal` (`super-yolo` only when the user opts in).
Status: T1 implemented, tested and independently verified (commit `dc28dc0`); T2–T5 specified, not implemented. gentle-shell contract verified at gentle-shell commit `0d181e872` (2026-11-23).

## Specs

User quotes are verbatim (Spanish, as written). "Agreed" lines record details the user accepted in the Log; they are part of the spec.

**S1 — Rotate with one key.**
> "Añadir una extensión de Gentle Shell que permita cambiar el modo de permisos de sesión con una tecla (o combinación) personalizable, rotando en orden circular" … "Equivalente en espíritu a `ctrl+t` (cambiar modelo) o `shift+tab` (nivel de pensamiento) en Pi: una pulsación avanza al siguiente modo sin entrar a `/gentle:customize` → Editor → Session permissions."
— for: the gentle-shell user, who changes permission mode without menus.
Agreed (L4, L6): rotation starts from the **current** mode, not from the saved default. Default order `normal → auto → yolo → normal`. Example: current `yolo` → press → `normal` → press → `auto` → press → `yolo`.

**S2 — Command name.**
> "si podemos usar /mode-cycle"
— for: the user, a short command that does not collide with gentle-shell's `gentle:` namespace (assumption).
Agreed (L8): `/mode-cycle` with no arguments does exactly what the key does.

**S3 — Default key, changeable.**
> "la idea es que la combinacion de teclas sea una por defecto que no choque con herdr + pi. podriamos meter la terminal pero no todas las terminales tienen la misma combinacion de teclas para todo . por ejemplo podria ser ctrl + m o alt + m, (a definir aun) y que si el usuario quiere cambiar la combinacion puede hacerlo."
> "tecla alt+m"
— for: users of herdr + Pi (and other terminals) who need a key nothing else captures.
Agreed (L6, L7):
- Default key `alt+m`. `ctrl+m` is rejected: terminals send it as Enter (carriage return). Also rejected: bare letters, `ctrl+i` (Tab), `ctrl+j` (line feed).
- The key comes from the extension's own config file `gentle-mode-cycle.json` in Pi's agent directory (resolved through Pi, never hard-coded). Not from an environment variable: the self-contained gentle-shell install launches Pi with a clean environment and does not read the user's shell rc files.
- `/mode-cycle key <key>` validates, saves, and tells the user to run `/reload` (Pi registers shortcuts only at load). `"off"` or `""` registers no key; the command keeps working.
- Invalid key in the file → warning, fall back to `alt+m`.
- `/mode-cycle status` shows the active key, whether super-yolo is included, and the config file path.
- The save message points to Pi's `/hotkeys` to check conflicts.

**S4 — super-yolo off by default, enabled explicitly.**
> "si incluimos superyolo a este tambien"
> "1. como seria la forma de habilitarlo despues, es decur cual seria la mecanica"
> "me parece lo que dices, sin super yolo por defecto."
— for: the user, who never lands in "no permission prompts" by pressing the key a few times.
Agreed (L5, L6, L7):
- Config field `includeSuperYolo`, default `false`. With it on: `normal → auto → yolo → super-yolo → normal`.
- `/mode-cycle super-yolo on|off` saves the field; it applies on the next press, no `/reload` (read on every press).
- If the current mode is `super-yolo` and it is excluded, the next mode is `normal` (never a more permissive one).

**S5 — Mode label in the bar follows the key.**
> "en una de las barras tiene el modo en que se esta trabajando, creo que normal no aparece, pero si auto yolo y superyolo no digo que la leamos, pero si podriamos cambiar este label,cada vez que se oprima la tecla tambien, revisalo"
— for: the user, who sees the new mode right after pressing.
Agreed (L5): the extension does **not** write the label. gentle-shell's own `setMode` already publishes it (`ctx.ui.setStatus("gentle:mode", "Permissions: <MODE>")`), so the bar updates exactly as with `/gentle:mode <mode>`. Writing it ourselves could show a mode that failed to apply.

**S6 — Feedback: visual on every press, sound on entering `normal`.**
> "podriamos poner sonido solo "cuando entramos" a modo normal, que seria algo como reinicia el ciclo ya que no hay notificacion visual"
> "ahoramismo en pi + gs y gs(autocontenido) reproducen sonido cada vez que el agente tiene notificaciones como completado atencion y fallo, podemos usar esos mismos"
— for: the user, who hears that the cycle restarted, since the bar does not show `normal`.
Agreed (L8, L10): a short notice (`Permissions: <MODE>`) on every successful press (config `notify`, default `true`); a sound only when the new mode is `normal` (config `bellOnNormal`, default `true`), played with the terminal bell (`\x07`), per the L13 decision (the original wish to reuse gentle-shell's notification sounds is not reachable without a second internal contract). Must not corrupt Pi's TUI rendering.

**S7 — Works in both installs.**
> "debe funcionar tanto en gs instalado independiente y como extension para pi con extension de gs"
— for: users of the self-contained gentle-shell install and users of Pi with the gentle-shell package.
Agreed (L9):
| | Self-contained gentle-shell | Pi + gentle-shell package |
|---|---|---|
| Agent dir (config) | `~/.local/share/gentle-shell/install/agent/` | `~/.pi/agent/` |
| Install | `~/.local/share/gentle-shell/install/bin/pi install <source>` | `pi install <source>` |
| gentle-shell version | pinned snapshot | may be newer |
README documents both installs and the gentle-shell versions tested.

**S8 — Without gentle-shell.**
> "si no se tiene instalado hacer la mencion y documentar en el readme de todas formas."
— for: someone who installs the extension without gentle-shell.
Agreed (L11): if gentle-shell does not answer, show a notice that gentle-shell is required; if `/gentle:yolo` exists (gentle-shell present but its internal contract changed), open it as fallback. The README states gentle-shell is required.

## Technical contract (gentle-shell, internal and unversioned)

The extension cannot import gentle-shell code (its `package.json` has no `exports`). It talks to gentle-shell through Pi's event bus. Source: `gentle-shell/lib/yolo-session-policy.ts`.

- Channel `"gentle:yolo:host-ui"` (constant not exported, `:72`). Emit `pi.events.emit("gentle:yolo:host-ui", { context: ctx, respond })`.
- gentle-shell calls `respond(adapter)`; reference wait 100 ms (`DISCOVERY_TIMEOUT_MS`, `:73`). No answer → unavailable.
- Adapter (`:74-85`): `readMode?(): Promise<Mode>`, `readSnapshot?()`, `setMode?(mode): Promise<boolean>` (**one argument**, context already bound), `dispose()`.
- **Always call `adapter.dispose()`** when done: each answer registers subscriptions.
- `setMode` is the same function `/gentle:mode <mode>` uses (interactive session and identity checks). The extension relaxes nothing; `setMode` returning `false` means the mode did not change.
- Modes (`MODE_CHOICES`, `:62`, not exported): `normal`, `auto`, `yolo`, `super-yolo`. Keep an own copy; a mode read outside this list → warning, no change.
- Public commands cannot replace the event: `/gentle:mode` without arguments only prints a notice (not readable by an extension); `/gentle:yolo` without arguments opens a menu (used only as fallback, S8).
- Bar label: `setMode` → `changed` → `publish` (`:186-204`, `:290`); read by `gentle-shell/extensions/gentle-shell.ts:389-411`.
- If gentle-shell renames the channel, payload, adapter methods, or modes, rotation stops (S8 fallback covers it) and this repo must be updated.
- Concurrency: ignore a press while a change is in flight, so two presses never compute the next mode from a stale read.

Notification sounds (S6), `gentle-shell/lib/notification-events.ts` and `extensions/gentle-notifications.ts:55-80`:
- Content-free bus `"gentle-pi:notification:source"`. The listener accepts **only** `source: "subagent"` events from the bus (main/session events are produced internally), with `parentSessionId === sessionId`, valid `producerId`/`runId`/increasing `sequence`, `occurredAt` within the session.
- `"herdr:blocked"` is the attention event; **must not** be emitted (herdr may mark the agent as blocked).

## Tasks

| ID | Specs | Route | Risk | Commit |
|---|---|---|---|---|
| T1 | S1, S2, S5, S7 (partial) | inline, test-first | item 2 (switches the session permission mode through gentle-shell's guard) → independent verify | `dc28dc0` |
| T2 | S8 | inline, test-first | none expected | — |
| T3 | S3 | inline, test-first | none expected | — |
| T4 | S4 | inline, test-first | item 2 (controls access to the most permissive mode) | — |
| T5 | S6 | inline, test-first | none expected | — |

- **T1 — Rotate `normal → auto → yolo` with `alt+m` and `/mode-cycle`.** Package (`package.json` with Pi extension manifest), extension entry, own mode list, event discovery with timeout, `setMode`, `dispose()`, unknown-mode guard, in-flight lock, `notify` notice. Fixed key `alt+m` (config arrives in T3). Tests with a fake gentle-shell adapter on a fake event bus: rotation from each mode, `super-yolo` current → `normal`, `setMode` false → no success notice, unknown mode → no change, `dispose()` always called, second press during a change ignored. README: what it does, both installs (S7), required gentle-shell. Manual check in both installs.
- **T2 — Missing or changed gentle-shell.** No answer → notice; `/gentle:yolo` fallback only when it exists. Tests for both branches. README section.
- **T3 — Configurable key.** `gentle-mode-cycle.json` in Pi's agent dir, validation and fallback, `"off"`, `/mode-cycle key <key>`, `/mode-cycle status`, `/reload` message with `/hotkeys` hint. Tests for valid, invalid, `ctrl+m`, bare letter, `off`, missing file. README section.
- **T4 — super-yolo opt-in.** `includeSuperYolo`, `/mode-cycle super-yolo on|off`, applied on next press. Tests for both rotations and the excluded-current rule. README section.
- **T5 — Sound on entering `normal`.** `bellOnNormal`, terminal bell `\x07` (L13). Tests: bell written only when the new mode is `normal` and the change succeeded, never when `bellOnNormal` is false. Manual check in both installs (WSL + herdr): audible and no TUI corruption. README section: the sound depends on the terminal's bell setting (e.g. Windows Terminal `bellStyle`).

## Log

- **L1** (original idea statement): "Añadir una extensión de Gentle Shell que permita cambiar el modo de permisos de sesión con una tecla (o combinación) personalizable, rotando en orden circular: normal → auto → yolo → super-yolo → normal. Equivalente en espíritu a `ctrl+t` (cambiar modelo) o `shift+tab` (nivel de pensamiento) en Pi: una pulsación avanza al siguiente modo sin entrar a `/gentle:customize` → Editor → Session permissions."
- **L2**: "ya revise y no hay algo parecido dentro de gs." — no existing equivalent in the gentle-shell community.
- **L3**: "si bien puedo mandar un pr o levantar un issue pidiendo este cambio, por lo que no parece que sea tan solicitado" — decision: standalone extension over the internal event (not a gentle-shell PR); accepted risk: internal contract may change.
- **L4**: "si mi default es yolo, y oprimo la tecla, cambiaria a normal, y si vuelvo a auto y otra vez a yolo, correcto, si incluimos superyolo a este tambien" — rotation from the current mode confirmed.
- **L5**: "en una de las barras tiene el modo en que se esta trabajando … podriamos cambiar este label,cada vez que se oprima la tecla tambien, revisalo" — evidence: gentle-shell `setMode` already publishes the label; decision: do not write it.
- **L6**: "1. como seria la forma de habilitarlo despues … 2. … que si el usuario quiere cambiar la combinacion puede hacerlo." — proposed: own config file + `/mode-cycle` subcommands; `ctrl+m` = Enter, rejected; env var rejected (clean environment in self-contained install).
- **L7**: "me parece lo que dices, sin super yolo por defecto. tecla alt+m" — `alt+m`, super-yolo opt-in. Also: `/gentle:customize` → Keybindings (`command:<name>`) discarded as mechanism ("esto me permite cambiar entre perfiles, no de modos perse … necesitamos que exista un perfil ya configurado").
- **L8**: "podriamos poner sonido solo "cuando entramos" a modo normal … si podemos usar /mode-cycle" — sound added to (not replacing) the visual notice; command `/mode-cycle`.
- **L9**: "debe funcionar tanto en gs instalado independiente y como extension para pi con extension de gs" — two installs supported.
- **L10**: "ahoramismo en pi + gs y gs(autocontenido) reproducen sonido … podemos usar esos mismos" — reuse gentle-shell notification sounds.
- **L11**: "si no se tiene instalado hacer la mencion y documentar en el readme de todas formas."
- **L12**: "generame el odd añade /context a exclude de git y que el odd sea autocontenido" — `context/` added to `.git/info/exclude`; this document is self-contained.
- **L14** (evidence, T1 verification round 1): the independent verifier found that the discovery payload carried only `respond`, while gentle-shell's listener returns silently unless `request.context` is truthy (`gentle-shell/lib/yolo-session-policy.ts:326`) — every press would have ended in "gentle-shell is not available" against the real gentle-shell, and the fake adapter hid it. Also: `README.md` was missing. Fixed in T1 before its commit: the Pi context travels through `discoverHostUi` and `cycleMode`, the test fake now keeps the real guard, a late or repeated answer is disposed, and tests cover a second sequential press and a thrown `readMode`. Mutation checks confirm the suite catches each of these (5 mutations → 14/1/1/7/4 failing tests).
- **L15** (evidence, T1 verification round 2): not blocked. `pnpm test` 18/18 (exit 0) and `pnpm typecheck` exit 0; a load through Pi's real SDK loader registers `alt+m` and `/mode-cycle` and rotates `auto → yolo` against a listener using the real guard. Not verifiable outside a live session: the real key press, the notice and status bar rendering, the real gentle-shell end to end, and `pi install` in both installs.
- **L13** (open decision, blocks T5): how to reuse gentle-shell's sounds. Findings: the only bus input gentle-shell accepts is a `subagent.<status>` event, so reuse means emitting a synthetic subagent event (e.g. `subagent.completed`) — a second internal contract that presents the mode change as a finished subagent; whether it also shows anywhere besides the sound is unverified. `herdr:blocked` is excluded. Alternatives: terminal bell (`\x07`), or a gentle-shell PR adding a public "play notification" event. **Decided:** user chose "Campana de la terminal (\x07)" — independent of gentle-shell, no internal contract; sound depends on the terminal.
