# Session Pins

**Pin instructions and live files so they're injected into every prompt of your Copilot CLI session.**

Copilot has no memory within a session beyond the rolling context. Session Pins lets you
*stick* the things that must stay salient — a rule, a decision, or a file — so they ride along
on every turn until you remove them.

- **Prompt pin** — an editable instruction added to every prompt (e.g. *"don't reinvent X, follow Y.md"*).
- **Live file pin** — a file re-read from disk on every prompt, so edits to it stay reflected automatically (up to the first 64 KB is injected; larger files are truncated).

Pins are stored in the **session folder** as `pins.json` — the session's workspace directory
(`session.workspacePath`) when available, otherwise `<COPILOT_HOME>/session-state/<id>/`
(defaulting to `~/.copilot/session-state/<id>/` when `COPILOT_HOME` is unset). Either way
they travel with the session, survive resuming it, and vanish when it's deleted. A new session starts empty.

## Install

### From the Agency Playground marketplace

```text
agency copilot
/plugin marketplace add agency-microsoft/playground
/plugin install session-pins@agency-playground
```

That's it — the pin tools and the `/pin` command load automatically. Start a new
Copilot session (so the extension loads at startup) and use `/pin`.

**Requires Copilot CLI 1.0.74+ with experimental mode enabled.** Extensions only
load in experimental mode, so launch with `copilot --experimental`, or enable it
persistently in `~/.copilot/settings.json`:

```json
{ "experimental": true }
```

No activation script, no manual copying — the extension ships inside the plugin at
`extensions/session-pins/` and Copilot loads it from the installed plugin directly.

### Local / from source

```text
/plugin install /path/to/session-pins
```

Then start a new session with experimental mode enabled (as above).

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

In the pinboard, prompt pins show in `"quotes"` and file pins are marked with `@`, so text-vs-file is obvious. Each pin also shows its state — `●` active, `○` disabled. Selecting a pin lets you **open** it in an editor (file pins only), edit it in place, **enable/disable** it (a quick way to silence a pin without deleting it), or delete it; `Esc` exits.

### Enabling and disabling pins

A disabled pin is kept in the list but not injected into prompts — handy for temporarily silencing a rule without losing it. Only you change this state, from the pinboard. To diagnose whether a pin is causing a problem, disable it for a turn or two and see if the behavior changes, then re-enable it.

## How Copilot uses the pin tools

When you ask in plain language, Copilot manages pins through a small set of tools. Knowing what they do helps you predict its behavior:

| Tool | What it does | Confirmation |
|------|--------------|--------------|
| `pin_prompt` | Pin an instruction | Asks before pinning |
| `pin_file` | Pin an existing file (relative paths resolve against the session files folder) | Asks before pinning |
| `pin_list` | List current pins with their numbers, state, and per-pin/total context cost | None (read-only) |
| `pin_remove` | Remove one pin by number or text/path match | Asks before removing |
| `pin_clear` | Remove all pins | Asks before clearing |

Every pin-changing tool is **model-initiated**, so each one asks you to confirm first (see *Safety* below). Only your own `/pin` commands change pins without a prompt. When Copilot needs to *create* a file and pin it, it writes the file into the session files folder in one step, then pins it in a later step.

### A worked example

> **You:** *"Create a `decisions.md` capturing that we use JWT auth and Postgres, then pin it."*
>
> 1. Copilot calls its file-create tool → writes `decisions.md` into the session files folder.
> 2. Copilot calls `pin_file` with `decisions.md` → you get a prompt: *"Allow Copilot to pin this file (…) ?"* → you approve.
> 3. Result: `decisions.md` is now pin **1**. Its contents are injected into every subsequent prompt, and stay current as the file is edited.
>
> **You:** *"What's pinned?"* → Copilot calls `pin_list`:
> ```text
> 1. (enabled) `@decisions.md` (~180 B)
> ≈ 180 B added to every prompt
> ```
>
> **You:** *"Unpin it."* → `pin_remove` (number `1`) → you approve → the pin is gone.

## Behavior and failure handling

Session Pins is designed to never break your prompt, even on bad input:

- **A pinned file that doesn't exist yet** — pinning still succeeds (so a *create-then-pin* request never races), the pin shows as `(not found)` in the pinboard and `/pin list`, and **nothing is injected** until the file exists. Once it does, its contents appear on the next prompt automatically.
- **A file that exists but can't be read** (e.g. a directory, or a permissions error) — a compact `could not be read (error code …)` notice is injected in its place. Only the error *code* is shown; the absolute path is never leaked.
- **A file larger than 64 KB** — only the first 64 KB is injected, followed by a `…[truncated]` marker. Pin large files sparingly: the injected bytes are added to **every** prompt.
- **A corrupt or partially-invalid `pins.json`** — malformed entries are dropped on load (with a logged warning) and the valid pins still load; the prompt hook never throws.
- **A relative path containing `..`** — rejected. Relative pins are rooted at the session files folder; to pin a file outside the session, pass an absolute path.
- **Experimental mode not enabled** — the extension doesn't load at all, so the `/pin` command and pin tools simply won't be present. Launch with `copilot --experimental` (see *Install*).

## Safety

Pinned content is re-injected into every prompt, so treat it with the same care as any always-on context:

- **Pinned file contents are data, not instructions.** They're injected inside a labeled `<live_file_pin>` wrapper (prompt pins inside `<prompt_pin>`), and XML metacharacters in file contents are escaped so a file can't "break out" of its wrapper. Copilot should treat text *inside* a pinned file as data to consider — not as commands to obey — which limits prompt-injection from pinned documents.
- **Model-initiated pin changes require your consent.** Because the pin tools are callable by the model, a prompt-injection (from a file, tool result, or web page) could try to pin, unpin, or clear on your behalf. Every model-initiated `pin_*` change asks for explicit confirmation and is **refused outright** when no confirmation UI is available. Only your direct `/pin` commands bypass this gate.
- **Don't pin secrets.** A pinned file is re-read into every prompt and sent to the model each turn — avoid pinning `.env` files, key material, tokens, or other sensitive files. The pinboard and `/pin list` show each pin's byte size and a running total so you can see exactly how much (and, by inspection, what) is being injected.
- **Disabled pins are redacted.** A disabled pin's content is not injected and is not echoed back to the model, so silencing a pin also hides its contents.

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
