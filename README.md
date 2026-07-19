# Session Pins

**Keep a small, editable brief — rules, decisions, and key files — salient for one Copilot CLI session, without touching your repo or creating cross-session memory.**

In a long session, the things that must stay true — a constraint, a decision you made, the file
that's the source of truth — get buried as the conversation grows or is compacted. Session Pins
*sticks* them so they ride along on every turn until you remove them. Unlike repository instruction
files or `/memory`, pins are **session-scoped and ephemeral**: they travel with the session and
vanish when it's deleted, so they never pollute your repo or persist across sessions.

- **Prompt pin** — an editable instruction added to every prompt (e.g. *"don't reinvent X, follow Y.md"*).
- **Live file pin** — a file re-read from disk on every prompt, so edits to it stay reflected automatically (up to the first 64 KB is injected; larger files are truncated). Best for small, evolving docs — a plan, decisions, acceptance criteria — not large source files.

Pins are stored in the **session folder** as `pins.json` — the session's workspace directory
(`session.workspacePath`) when available, otherwise `~/.copilot/session-state/<id>/`. Either way
they travel with the session, survive resuming it, and vanish when it's deleted. A new session starts empty.

## Install

### From the Agency Playground marketplace

```text
agency copilot
/plugin marketplace add agency-microsoft/playground
/plugin install session-pins@agency-playground
```

**One-time activation.** Installing registers the plugin, but Copilot CLI doesn't yet
auto-load a plugin's *extension* (the part that provides the `/pin` command and the pin
tools) — that's still behind a feature flag. And for safety the CLI never runs a plugin's
scripts for you, so you run a small script once yourself. It just copies the extension into
`~/.copilot/extensions/`, where Copilot loads it on startup:

```powershell
& "$HOME\.copilot\installed-plugins\agency-playground\session-pins\install.ps1"
```
```bash
"$HOME/.copilot/installed-plugins/agency-playground/session-pins/install.sh"
```

Then relaunch Copilot with **`--experimental`** (extensions only load in experimental mode;
you can also toggle it in-session with `/experimental`). You'll see a reminder with this same
command right after install.

### Local / from source

From the plugin folder:

```powershell
.\install.ps1        # Windows
```
```bash
./install.sh         # Linux / macOS
```

Then run `copilot --experimental`.

## Use

### Just ask Copilot (plain language)

The simplest way — talk to Copilot and it uses the pin tools for you:

- *"Pin the rule that tenant states come from the MD playbooks — don't reinvent them."*
- *"Pin `@docs/architecture.md` so you keep it in context."*
- *"What's pinned?"*  /  *"Unpin the tenant rule."*  /  *"Clear all pins."*
- *"Create a `decisions.md`, capture our API choices, and pin it."* (Copilot writes the doc into the session's files folder, then pins it)

### The `/pin` command

For direct, interactive control there's a single `/pin` command:

```text
/pin                  Open the pinboard (browse / add / edit / enable-disable / delete)
/pin add <text>       Pin an instruction
/pin add @<path>      Pin a live file  (type @ to open the file picker)
/pin list             List pins
/pin edit [n]         Edit a pin in place
/pin remove [n]       Remove a pin
/pin clear            Remove all
```

In the pinboard, prompt pins show in `"quotes"` and file pins are marked with `@`, so text-vs-file is obvious. Each pin also shows its state — `●` active, `○` disabled. Selecting a pin lets you **open** it in an editor (file pins — Copilot opens it for you), **enable/disable** it (a quick way to silence a pin without deleting it), edit it in place, or delete it; `Esc` exits.

### Enabling and disabling pins

A disabled pin is kept in the list but not injected into prompts — handy for temporarily silencing a rule without losing it. Only you change this state, from the pinboard.

Disabling doubles as the diagnostic: if a pinned rule or file seems to be causing trouble, disable it, re-run the step, and re-enable it if it wasn't the cause. Copilot will also point out (by its number) any pin that looks stale or in conflict, but only you change a pin's state or remove it.

## Alternative: force-load an instructions file from the session folder

If you'd rather use Copilot's native instruction files than a pin, point the
**`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`** env var at a directory and Copilot will always load
instruction files it finds there — `AGENTS.md` (at the dir root) or `copilot-instructions.md`
(under `.github/`) — on every prompt.

```powershell
# Windows — load an AGENTS.md placed in the current session folder
$env:COPILOT_CUSTOM_INSTRUCTIONS_DIRS = "$HOME\.copilot\session-state\<session-id>"
```
```bash
# Linux / macOS
export COPILOT_CUSTOM_INSTRUCTIONS_DIRS="$HOME/.copilot/session-state/<session-id>"
```

Drop an `AGENTS.md` (or `.github/copilot-instructions.md`) in that folder and it's loaded every
turn — no pinning needed. Handy when you want durable, file-backed instructions that live with
the session but are edited like any normal Markdown file.
