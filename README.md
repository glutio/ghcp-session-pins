# Session Pins

**Pin instructions and live files so they're injected into every prompt of your Copilot CLI session.**

Copilot has no memory within a session beyond the rolling context. Session Pins lets you
*stick* the things that must stay salient — a rule, a decision, or a file — so they ride along
on every turn until you remove them.

- **Prompt pin** — an editable instruction added to every prompt (e.g. *"don't reinvent X, follow Y.md"*).
- **Live file pin** — a file re-read from disk on every prompt, so edits to it stay reflected automatically.

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
scripts for you. So the plugin ships a one-time activation command — run it and approve when
Copilot asks:

```text
/session-pins:install
```

It copies the extension into `~/.copilot/extensions/` (where Copilot loads it on startup). Then
relaunch Copilot with **`--experimental`** (extensions only load in experimental mode; you can
also toggle it in-session with `/experimental`). Running `/session-pins:install` again later is
safe and is also how you **update**: if you upgrade the plugin, re-run it and it refreshes the
installed extension automatically (no flags needed); if nothing changed it just says it's already
up to date.

Prefer to do it by hand? Run the bundled installer directly instead — it's at the root of the
installed plugin folder (`…/installed-plugins/<marketplace>/session-pins/`):

```powershell
& "$HOME\.copilot\installed-plugins\<marketplace>\session-pins\install.ps1"
```
```bash
"$HOME/.copilot/installed-plugins/<marketplace>/session-pins/install.sh"
```

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

In the pinboard, prompt pins show in `"quotes"` and file pins are marked with `@`, so text-vs-file is obvious. Each pin also shows its state — `●` active, `○` disabled. Selecting a pin lets you **enable/disable** it (a quick way to silence a pin without deleting it), edit it in place, or delete it; `Esc` exits.

### Enabling, disabling, and diagnosing pins

A disabled pin is kept in the list but not injected into prompts — handy for temporarily silencing a rule without losing it. Only you change this state, from the pinboard.

When Copilot is diagnosing a problem, it can also *test* whether a pin is the culprit: the `test_without_pin` tool omits a single pin from **just the next turn** and then restores it automatically. This is in-memory only and never written to disk, so the agent can experiment safely — it can't leave a pin "stuck off", and it can never permanently disable a pin (that's yours to control).

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
